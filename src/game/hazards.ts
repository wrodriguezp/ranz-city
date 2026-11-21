// Peligros en el suelo, señuelos y suministros aéreos: todo lo que "queda" en un lugar del mapa
// durante un rato y afecta lo que pasa alrededor.
//
//  - FUEGO (molotov, lanzallamas): un círculo que prende a los zombies que lo pisan. Un zombie
//    ardiendo pierde vida durante unos segundos y puede contagiar a los que tiene pegados: tirar
//    un molotov en medio de una horda apretada es la idea. Al jugador también lo quema.
//  - ÁCIDO (escupidor): un charco que daña al jugador mientras lo pise. Obliga a moverse.
//  - SEÑUELOS: petardos, una radio, la alarma de un auto, la bengala. Cada uno hace ruido una y
//    otra vez (un "pulso" por cada cierto tiempo). Como los zombies van al LUGAR del ruido, un
//    señuelo bien tirado saca a una horda de tu camino.
//  - SUMINISTRO: la bengala pide un avión. El cajón cae en paracaídas unos 20 s después, donde
//    cayó la bengala. Pero la bengala también se ve y se oye: hay que aguantar hasta que llegue.
//
// Todo esto es estado dinámico plano (arreglos de objetos simples en GameState).

import type { LootItem } from '../world/props';
import { random } from './random';
import type { GameState, Hazard, Lure } from './state';
import { damageZombie, hurtPlayer, makeNoise, type ZombieRuntime } from './zombies';

/** Daño por "tic" (4 tics por segundo) al jugador y a los zombies que arden. */
const HAZARD_TICK = 15;
const FIRE_PLAYER = 6;
const ACID_PLAYER = 4;
const BURN_DAMAGE = 10;
const BURN_TIME = 4;
/** Probabilidad por tic de que un zombie en llamas prenda a uno que tenga pegado. */
const BURN_SPREAD = 0.3;

interface LureSpec {
  duration: number;
  /** Segundos entre pulsos de ruido. */
  every: number;
  noise: number;
}

const LURES: Record<Lure['kind'], LureSpec> = {
  // Petardos: una ristra corta y MUY ruidosa.
  firecracker: { duration: 5, every: 0.35, noise: 28 },
  // La radio: más baja, pero dura mucho. Sirve para vaciar una calle con calma.
  radio: { duration: 18, every: 1.2, noise: 22 },
  // La alarma del auto: fuerte y larga. La pone el jugador... o se la pone sin querer.
  alarm: { duration: 12, every: 1, noise: 34 },
  // La bengala casi no suena, pero dura lo que tarda el avión.
  flare: { duration: 22, every: 2.5, noise: 9 },
};

/** Segundos desde la bengala hasta que el cajón toca el suelo. */
export const DROP_DELAY = 20;
/** El cajón se ve bajando en paracaídas durante sus últimos segundos. */
export const DROP_DESCENT = 6;
const DROP_NOISE = 30;

export function addHazard(state: GameState, kind: Hazard['kind'], x: number, y: number, radius: number, timer: number): void {
  // Un fuego nuevo encima de otro casi igual solo lo renueva (el lanzallamas deja muchos).
  const same = state.hazards.find((h) => h.kind === kind && Math.hypot(h.x - x, h.y - y) < radius * 0.6);
  if (same) {
    same.timer = Math.max(same.timer, timer);
    same.maxTimer = Math.max(same.maxTimer, same.timer);
    same.radius = Math.max(same.radius, radius);
    return;
  }
  state.hazards.push({ kind, x, y, radius, timer, maxTimer: timer });
  if (state.hazards.length > 40) state.hazards.shift();
}

export function addLure(state: GameState, kind: Lure['kind'], x: number, y: number): void {
  const spec = LURES[kind];
  state.lures.push({ kind, x, y, timer: spec.duration, pulse: 0 });
  if (kind === 'flare') {
    state.drops.push({ x, y, fall: DROP_DELAY, opened: false, loot: rollDrop(state) });
    state.events.push({ type: 'message', text: `Bengala encendida: el suministro cae en ${DROP_DELAY} s. ¡Aguanta!`, tone: 'good' });
  }
}

/**
 * Lo que trae el cajón: siempre un arma especial (es la gracia de pedirlo), munición y algo
 * para curarse. Sale del azar dinámico: el cajón no existe en el mundo estático de la seed.
 */
function rollDrop(state: GameState): LootItem[] {
  const specials = ['minigun', 'flamer', 'rocket'] as const;
  const special = specials[Math.floor(random(state) * specials.length)];
  return [
    { type: special, amount: 1 },
    { type: 'ammo', amount: 30 },
    { type: 'shells', amount: 8 },
    { type: 'medkit', amount: 1 },
    { type: random(state) < 0.5 ? 'molotov' : 'grenade', amount: 2 },
  ];
}

/** Fuego, ácido, zombies ardiendo, señuelos y suministros. Va después de updateZombies. */
export function updateHazards(state: GameState, rt: ZombieRuntime, dt: number): void {
  const tick = state.tick % HAZARD_TICK === 0;
  const { player } = state;

  // 1. Peligros en el suelo.
  let playerFire = false;
  let playerAcid = false;
  for (let i = state.hazards.length - 1; i >= 0; i--) {
    const h = state.hazards[i];
    h.timer -= dt;
    if (h.timer <= 0) {
      state.hazards.splice(i, 1);
      continue;
    }
    // Al final de su vida el círculo se achica: el borde "se apaga" primero.
    const radius = h.radius * Math.min(1, 0.4 + h.timer / 1.5);
    if (Math.hypot(player.x - h.x, player.y - h.y) < radius + 0.2 && player.air < 0.5) {
      if (h.kind === 'fire') playerFire = true;
      else playerAcid = true;
    }
    if (h.kind === 'fire' && tick) {
      rt.hash.query(h.x, h.y, radius + 0.5, (j) => {
        const z = state.zombies[j];
        if (z && z.hp > 0 && z.air < 1 && Math.hypot(z.x - h.x, z.y - h.y) < radius + z.radius) z.burn = Math.max(z.burn, BURN_TIME);
      });
    }
  }
  if (tick && (playerFire || playerAcid)) {
    hurtPlayer(state, playerFire ? FIRE_PLAYER : ACID_PLAYER);
    state.events.push({ type: 'sfx', name: playerFire ? 'ignite' : 'spit', x: player.x, y: player.y });
    // Que se entienda por qué baja la vida: el charco puede quedar tapado por algo.
    if (state.time - state.alert.acidTold > 4) {
      state.alert.acidTold = state.time;
      state.events.push({ type: 'message', text: playerFire ? '¡Te estás quemando! Sal del fuego' : '¡Estás pisando ácido! Sal del charco', tone: 'danger' });
    }
  }

  // 2. Zombies ardiendo: pierden vida y contagian a los que tienen pegados.
  for (let i = 0; i < state.zombies.length; i++) {
    const z = state.zombies[i];
    if (z.burn <= 0 || z.hp <= 0) continue;
    z.burn -= dt;
    // Cada uno arde en su propio tic (según su id) para repartir el costo.
    if ((state.tick + z.id) % HAZARD_TICK !== 0) continue;
    // El tanque arde menos: tiene demasiada carne.
    damageZombie(state, z, z.kind === 'tank' ? BURN_DAMAGE * 2 : BURN_DAMAGE, 0, 0, 0, { quiet: true, burn: true });
    rt.hash.query(z.x, z.y, z.radius + 0.6, (j) => {
      const o = state.zombies[j];
      if (!o || o === z || o.hp <= 0 || o.burn > 0) return;
      if (Math.hypot(o.x - z.x, o.y - z.y) < z.radius + o.radius + 0.15 && random(state) < BURN_SPREAD) o.burn = BURN_TIME * 0.8;
    });
  }

  // 3. Señuelos.
  for (let i = state.lures.length - 1; i >= 0; i--) {
    const lure = state.lures[i];
    const spec = LURES[lure.kind];
    lure.timer -= dt;
    lure.pulse -= dt;
    if (lure.timer <= 0) {
      state.lures.splice(i, 1);
      continue;
    }
    if (lure.pulse > 0) continue;
    lure.pulse = spec.every;
    makeNoise(state, lure.x, lure.y, spec.noise, rt);
    if (lure.kind === 'alarm') state.events.push({ type: 'alarm', x: lure.x, y: lure.y });
    else if (lure.kind !== 'flare') state.events.push({ type: 'sfx', name: lure.kind, x: lure.x, y: lure.y });
  }

  // 4. Suministros que vienen bajando.
  for (const drop of state.drops) {
    if (drop.fall <= 0) continue;
    const before = drop.fall;
    drop.fall -= dt;
    // El avión se oye pasar unos segundos antes de que caiga el cajón.
    if (before > DROP_DESCENT + 2 && drop.fall <= DROP_DESCENT + 2) state.events.push({ type: 'sfx', name: 'plane', x: drop.x, y: drop.y });
    if (drop.fall <= 0) {
      drop.fall = 0;
      // Al caer hace ruido: hay que llegar antes que ellos.
      makeNoise(state, drop.x, drop.y, DROP_NOISE, rt);
      state.events.push({ type: 'sfx', name: 'landing', x: drop.x, y: drop.y });
      state.events.push({ type: 'message', text: 'El suministro tocó el suelo: ¡ve a abrirlo [E]!', tone: 'good' });
    }
  }
}
