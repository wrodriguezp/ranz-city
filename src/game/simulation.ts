// Un paso de la simulación: une jugador, linterna, zombies y hordas.
//
// stepGame(estado, runtime, intención, dt) es todo el "juego" sin dibujo: main.ts arma la
// intención a partir del teclado y el mouse, llama a esta función 60 veces por segundo,
// y después el render lee el estado. Nada de aquí importa Three.js.

import type { City } from '../world/city';
import { dangerAt } from '../world/zones';
import { unstuck } from './collision';
import { createEscape, radioExitAt, updateEscape } from './escape';
import { createDirector } from './zombies';
import { createLoot, updateLoot } from './loot';
import { createWeapons, updateCombat, type CombatIntent } from './combat';
import { updateExplosives } from './explosives';
import { updateHazards } from './hazards';
import { BLOCK_SIZE, STREET_WIDTH, Tile } from '../world/tileGrid';
import { isSolid } from './collision';
import { createFlashlight, updateFlashlight } from './flashlight';
import { FlowField } from './flowField';
import { createPlayer, PLAYER_MAX_HP, updatePlayer } from './player';
import { random } from './random';
import { SpatialHash } from './spatialHash';
import type { GameState } from './state';
import { createZombie, initialHordeTimer, makeNoise, updateHordes, updateZombies, type ZombieRuntime } from './zombies';

/** Estructuras auxiliares que se derivan del mundo y del estado: no se serializan. */
export type Runtime = ZombieRuntime;

/** Lo que el jugador quiere hacer en este paso, ya en coordenadas del mundo. */
export interface Intent extends CombatIntent {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  toggleFlashlight: boolean;
  changeBattery: boolean;
  useMedkit: boolean;
  /** E mantenida: revisar el contenedor cercano. */
  search: boolean;
  /** Shift mantenido: agachado. */
  sneak: boolean;
  /** Espacio: dash. */
  dash: boolean;
}

/** Cada cuántos tiles caminados suena una pisada. */
const STRIDE = 1.6;
/** Las pisadas normales se oyen a unos pocos tiles: alcanza para despertar al que está al lado. */
const FOOTSTEP_NOISE = 4.5;

const MEDKIT_HEAL = 60;
/** Cada cuántos pasos se recalcula el campo de flujo de los flanqueadores (un BFS de la grilla). */
const FLANK_EVERY = 12;
/** Cuántos segundos hacia adelante miran los flanqueadores al predecir por dónde vas. */
const FLANK_LEAD = 2.5;
/** De los zombies que empiezan parados en un cruce, esta fracción son acechadores. */
const AMBUSH_CHANCE = 0.45;
/** Vida extra de los soldados del retén (multiplicador). */
const ARMOR_HP = 2.2;

export function createRuntime(city: City): Runtime {
  return {
    city,
    field: new FlowField(city.grid),
    noiseField: new FlowField(city.grid),
    flankField: new FlowField(city.grid),
    hash: new SpatialHash(city.grid.width, city.grid.height, 2),
  };
}

export function createGameState(city: City): GameState {
  const state: GameState = {
    status: 'playing',
    time: 0,
    tick: 0,
    // El azar dinámico también parte de la seed: misma seed y mismas acciones, misma partida.
    rng: (city.seed ^ 0x9e3779b9) >>> 0,
    weather: city.weather,
    player: createPlayer(city.spawn.x, city.spawn.y),
    flashlight: createFlashlight(),
    weapon: createWeapons(),
    // Se arranca con un molotov y unos petardos: para probarlos sin tener que buscarlos.
    inventory: { medkits: 1, batteries: 1, grenades: 1, molotovs: 1, firecrackers: 1, radios: 0, flares: 0, throwable: 'grenade' },
    loot: createLoot(city.props.length),
    escape: createEscape(city.evac),
    zombies: [],
    nextZombieId: 0,
    projectiles: [],
    barrelsBlown: city.barrels.map(() => false),
    pendingBlasts: [],
    hazards: [],
    lures: [],
    drops: [],
    alarmsFired: city.props.map(() => false),
    corpses: [],
    hordeTimer: initialHordeTimer(),
    noiseHeat: 0,
    director: createDirector(),
    alert: { timer: 0, told: -999 },
    lastNoise: { x: city.spawn.x, y: city.spawn.y, time: -999 },
    stats: { kills: 0, shots: 0, hordes: 0 },
    events: [],
  };
  applyBarrels(city, state.barrelsBlown);
  for (const spawn of city.encounters.zombies) {
    const z = createZombie(state, spawn.x, spawn.y, spawn.kind);
    if (spawn.armored) {
      z.armored = true;
      z.hp = z.maxHp = Math.round(z.hp * ARMOR_HP);
    }
    // Los grupos se reparten al azar: si alguno quedó rozando una pared, lo empujamos afuera.
    const fixed = unstuck(city.grid, z.x, z.y, z.radius);
    z.x = z.prevX = z.homeX = fixed.x;
    z.y = z.prevY = z.homeY = fixed.y;
    // Acechadores: algunos comunes que arrancan en un cruce se quedan ahí, agazapados.
    if ((z.kind === 'walker' || z.kind === 'runner') && atCrossing(z.x, z.y) && random(state) < AMBUSH_CHANCE) {
      z.role = 'ambusher';
      z.mode = 'idle';
    }
    state.zombies.push(z);
  }
  return state;
}

export function stepGame(state: GameState, rt: Runtime, intent: Intent, dt: number): void {
  if (state.status !== 'playing') return;
  state.time += dt;
  state.tick++;

  // La minigun pesa: mientras disparas caminas a un 60 %.
  const heavy = state.weapon.current === 'minigun' && intent.attackHeld ? 0.6 : 1;
  const dash = updatePlayer(state.player, { ...intent, moveX: intent.moveX * heavy, moveY: intent.moveY * heavy }, rt.city.grid, dt);
  if (dash) state.events.push({ type: 'sfx', name: dash, x: state.player.x, y: state.player.y });
  footsteps(state);

  updateItems(state, intent);
  updateFlashlight(state.flashlight, dt);

  // El combate va antes que los zombies: lo que muere en este paso ya no ataca.
  updateCombat(state, rt, intent, dt);
  // En la zona de una salida, E es la radio (no revisar la caja de al lado).
  const atRadio = radioExitAt(state, rt.city.evac) >= 0;
  updateLoot(state, rt, intent.search && !atRadio, dt);
  updateExplosives(state, rt, dt);

  rt.field.update(state.player.x, state.player.y);
  if (state.tick % FLANK_EVERY === 0) updateFlankField(state, rt, dt);
  updateZombies(state, rt, dt);
  // Fuego, ácido y señuelos: después de los zombies, porque usan la grilla espacial ya armada.
  updateHazards(state, rt, dt);
  updateHordes(state, rt, dt, dangerAt(rt.city.zones, state.player.x, state.player.y));

  updateEscape(state, rt, rt.city.evac, intent.search && atRadio, dt);

  if (state.player.hp <= 0 && state.status === 'playing') {
    state.status = 'lost';
    state.events.push({ type: 'message', text: 'Te alcanzaron.', tone: 'danger' });
  }
}

/**
 * Los barriles son lo único del mundo estático que cambia durante la partida. La grilla guarda
 * su versión "actual", y esta función la vuelve a armar desde el estado dinámico: al reiniciar
 * (todos de vuelta) o, en el futuro, al cargar una partida o recibir el estado del host.
 */
export function applyBarrels(city: City, blown: readonly boolean[]): void {
  for (const barrel of city.barrels) {
    city.grid.tiles[barrel.y * city.grid.width + barrel.x] = blown[barrel.id] ? Tile.Sidewalk : Tile.Barrel;
  }
}

/** ¿Está el punto dentro de un cruce de calles? (la grilla se repite cada calle + manzana). */
function atCrossing(x: number, y: number): boolean {
  const period = STREET_WIDTH + BLOCK_SIZE;
  return Math.floor(x) % period < STREET_WIDTH && Math.floor(y) % period < STREET_WIDTH;
}

/**
 * Los flanqueadores no van a donde estás sino a donde VAS: el origen de su campo de flujo es tu
 * posición adelantada según tu velocidad. Si el punto adelantado cae en un muro, se retrocede
 * hacia ti hasta encontrar suelo libre.
 */
function updateFlankField(state: GameState, rt: Runtime, dt: number): void {
  const p = state.player;
  const vx = (p.x - p.prevX) / dt;
  const vy = (p.y - p.prevY) / dt;
  for (let k = 1; k >= 0; k -= 0.25) {
    const x = p.x + vx * FLANK_LEAD * k;
    const y = p.y + vy * FLANK_LEAD * k;
    if (x < 0 || y < 0 || x >= rt.city.grid.width || y >= rt.city.grid.height) continue;
    if (isSolid(rt.city.grid, Math.floor(x), Math.floor(y))) continue;
    rt.flankField.update(x, y);
    return;
  }
}

/**
 * Pisadas. Caminando normal, cada paso es un ruido chico: los zombies muy cercanos lo oyen
 * aunque no te vean. Agachado (Shift) los pasos no hacen ruido: es la base del sigilo.
 */
function footsteps(state: GameState): void {
  const p = state.player;
  if (p.stride < STRIDE) return;
  p.stride = 0;
  state.events.push({ type: 'sfx', name: 'step', x: p.x, y: p.y });
  if (!p.sneaking) makeNoise(state, p.x, p.y, FOOTSTEP_NOISE);
}

/** Linterna, baterías y botiquines. */
function updateItems(state: GameState, intent: Intent): void {
  const { flashlight, inventory, player } = state;
  if (intent.toggleFlashlight) state.flashlight.on = !state.flashlight.on;

  // Cambiar la batería: a mano con B, o sola cuando la puesta se agota y hay repuesto.
  const empty = flashlight.charge <= 0 && flashlight.on;
  if ((intent.changeBattery || empty) && inventory.batteries > 0 && flashlight.charge < 95) {
    inventory.batteries--;
    flashlight.charge = 100;
    state.events.push({ type: 'message', text: 'Batería nueva en la linterna', tone: 'good' });
    state.events.push({ type: 'sfx', name: 'battery', x: player.x, y: player.y });
  } else if (intent.changeBattery && inventory.batteries === 0) {
    state.events.push({ type: 'message', text: 'No tienes baterías de repuesto' });
  }

  if (intent.useMedkit) {
    if (inventory.medkits === 0) {
      state.events.push({ type: 'message', text: 'No tienes botiquines' });
    } else if (player.hp >= PLAYER_MAX_HP) {
      state.events.push({ type: 'message', text: 'Tu vida ya está completa' });
    } else {
      inventory.medkits--;
      player.hp = Math.min(PLAYER_MAX_HP, player.hp + MEDKIT_HEAL);
      state.events.push({ type: 'message', text: `+${MEDKIT_HEAL} de vida`, tone: 'good' });
      state.events.push({ type: 'sfx', name: 'medkit', x: player.x, y: player.y });
    }
  }
}
