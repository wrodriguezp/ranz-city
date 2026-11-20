// Un paso de la simulación: une jugador, linterna, zombies y hordas.
//
// stepGame(estado, runtime, intención, dt) es todo el "juego" sin dibujo: main.ts arma la
// intención a partir del teclado y el mouse, llama a esta función 60 veces por segundo,
// y después el render lee el estado. Nada de aquí importa Three.js.

import type { City } from '../world/city';
import { dangerAt } from '../world/zones';
import { moveCircle } from './collision';
import { createEscape, updateEscape } from './escape';
import { createLoot, updateLoot } from './loot';
import { createWeapons, updateCombat, type CombatIntent } from './combat';
import { createFlashlight, updateFlashlight } from './flashlight';
import { FlowField } from './flowField';
import { createPlayer, PLAYER_MAX_HP, updatePlayer } from './player';
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
}

/** Cada cuántos tiles caminados suena una pisada. */
const STRIDE = 1.6;
/** Las pisadas normales se oyen a unos pocos tiles: alcanza para despertar al que está al lado. */
const FOOTSTEP_NOISE = 4.5;

const MEDKIT_HEAL = 60;

export function createRuntime(city: City): Runtime {
  return {
    city,
    field: new FlowField(city.grid),
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
    player: createPlayer(city.spawn.x, city.spawn.y),
    flashlight: createFlashlight(),
    weapon: createWeapons(),
    inventory: { medkits: 1, batteries: 1 },
    loot: createLoot(city.props.length),
    escape: createEscape(city.evac),
    zombies: [],
    nextZombieId: 0,
    corpses: [],
    hordeTimer: initialHordeTimer(),
    noiseHeat: 0,
    stats: { kills: 0, shots: 0, hordes: 0 },
    events: [],
  };
  for (const spawn of city.encounters.zombies) {
    const z = createZombie(state, spawn.x, spawn.y, spawn.kind);
    // Los grupos se reparten al azar: si alguno quedó rozando una pared, lo empujamos afuera.
    const fixed = moveCircle(city.grid, z.x, z.y, z.radius, 0, 0);
    z.x = z.prevX = z.homeX = fixed.x;
    z.y = z.prevY = z.homeY = fixed.y;
    state.zombies.push(z);
  }
  return state;
}

export function stepGame(state: GameState, rt: Runtime, intent: Intent, dt: number): void {
  if (state.status !== 'playing') return;
  state.time += dt;
  state.tick++;

  updatePlayer(state.player, intent, rt.city.grid, dt);
  footsteps(state);

  updateItems(state, intent);
  updateFlashlight(state.flashlight, dt);

  // El combate va antes que los zombies: lo que muere en este paso ya no ataca.
  updateCombat(state, rt, intent, dt);
  updateLoot(state, rt, intent.search, dt);

  rt.field.update(state.player.x, state.player.y);
  updateZombies(state, rt, dt);
  updateHordes(state, rt, dt, dangerAt(rt.city.zones, state.player.x, state.player.y));

  updateEscape(state, rt, rt.city.evac, dt);

  if (state.player.hp <= 0 && state.status === 'playing') {
    state.status = 'lost';
    state.events.push({ type: 'message', text: 'Te alcanzaron.', tone: 'danger' });
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
