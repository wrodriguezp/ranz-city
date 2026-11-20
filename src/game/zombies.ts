// Inteligencia de los zombies y las hordas.
//
// Cada zombie es una máquina de estados (ver ZombieMode en state.ts). Las decisiones caras
// (¿veo al jugador?, que necesita lanzar un rayo) no se toman en cada paso: cada zombie "piensa"
// 6 veces por segundo, repartidos (el zombie con id 0 piensa en el paso 0, el 1 en el paso 1...),
// así el costo se reparte parejo y no hay picos. El movimiento sí se actualiza en cada paso.
//
// Cómo encuentran al jugador:
//  - VISTA: rayo sobre la grilla (lineOfSight). Alcance corto en la oscuridad y largo si llevas
//    la linterna encendida: la luz te deja ver, pero también te delata.
//  - OÍDO: los ruidos (disparos, golpes) atraen a todos los zombies en un radio (makeNoise).
//  - HORDAS: cada cierto tiempo (o si haces mucho ruido) aparece un grupo fuera de tu vista que
//    ya sabe dónde estás y te persigue usando el campo de flujo (flowField.ts).

import type { City } from '../world/city';
import { isSolid, moveCircle } from './collision';
import { flashlightPower } from './flashlight';
import type { FlowField } from './flowField';
import { PLAYER_RADIUS } from './player';
import { random, randomRange } from './random';
import type { SpatialHash } from './spatialHash';
import type { GameState, Zombie, ZombieKind } from './state';
import { angleBetween, lineOfSight } from './visibility';

/** Lo que necesita la IA además del estado: el mundo y estructuras auxiliares que se recalculan. */
export interface ZombieRuntime {
  city: City;
  field: FlowField;
  hash: SpatialHash;
}

const STATS: Record<
  ZombieKind,
  { hp: number; radius: number; minSpeed: number; maxSpeed: number; damage: number; cooldown: number; reach: number }
> = {
  walker: { hp: 100, radius: 0.35, minSpeed: 2.6, maxSpeed: 3.9, damage: 9, cooldown: 1.1, reach: 0.45 },
  tank: { hp: 1100, radius: 0.8, minSpeed: 2.1, maxSpeed: 2.1, damage: 30, cooldown: 1.6, reach: 0.55 },
};

const WANDER_SPEED = 0.7;
const THINK_EVERY = 10;
/** Más lejos que esto, los zombies que no persiguen ni se mueven: ahorra CPU y nadie lo nota. */
const SLEEP_DISTANCE = 48;
const SIGHT_DARK = 6;
const SIGHT_LIT = 19;
const VIEW_CONE = (150 * Math.PI) / 180;
/** Segundos sin ver al jugador antes de rendirse y quedar "investigando" su última posición. */
const LOSE_INTEREST = 6;

const CHARGE_SPEED = 10;
const CHARGE_MIN = 4;
const CHARGE_MAX = 12;
const CHARGE_TIME = 1.1;
const CHARGE_COOLDOWN = 5;
const CHARGE_DAMAGE = 35;
const CHARGE_STUN = 1.6;

export const MAX_ZOMBIES = 450;
const HORDE_FIRST = 90;
const HORDE_INTERVAL = 100;
const HORDE_HEAT_LIMIT = 10;
const HORDE_CHASE_TIME = 75;

export function createZombie(state: GameState, x: number, y: number, kind: ZombieKind): Zombie {
  const stats = STATS[kind];
  return {
    id: state.nextZombieId++,
    kind,
    x,
    y,
    prevX: x,
    prevY: y,
    facing: random(state) * Math.PI * 2,
    hp: stats.hp,
    maxHp: stats.hp,
    radius: stats.radius,
    speed: randomRange(state, stats.minSpeed, stats.maxSpeed),
    mode: kind === 'tank' ? 'idle' : random(state) < 0.5 ? 'idle' : 'wander',
    timer: randomRange(state, 1, 5),
    targetX: x,
    targetY: y,
    seesPlayer: false,
    lastSeenAt: -999,
    attackCooldown: 0,
    knockX: 0,
    knockY: 0,
    stagger: 0,
    hitFlash: 0,
    hordeUntil: 0,
    homeX: x,
    homeY: y,
  };
}

export function initialHordeTimer(): number {
  return HORDE_FIRST;
}

/**
 * Un ruido en (x, y) que se oye hasta `radius` tiles. Los zombies cercanos van a investigar;
 * los muy cercanos ya saben dónde estás y persiguen directamente.
 */
export function makeNoise(state: GameState, x: number, y: number, radius: number): void {
  for (const z of state.zombies) {
    // El tanque está "de guardia": oye menos.
    const r = z.kind === 'tank' ? radius * 0.6 : radius;
    const d = Math.hypot(z.x - x, z.y - y);
    if (d > r || z.mode === 'chase' || z.mode === 'charge' || z.mode === 'stunned') continue;
    if (d < r * 0.4) {
      z.mode = 'chase';
      z.lastSeenAt = state.time;
    } else {
      z.mode = 'investigate';
      z.timer = 9;
    }
    // Apuntan al ruido con algo de error: no todos llegan exactamente al mismo punto.
    z.targetX = x + randomRange(state, -2, 2);
    z.targetY = y + randomRange(state, -2, 2);
  }
}

/** Aplica daño. Devuelve true si lo mató. */
export function damageZombie(
  state: GameState,
  z: Zombie,
  damage: number,
  knockX: number,
  knockY: number,
  stagger: number,
): boolean {
  if (z.hp <= 0) return false;
  // Un tanque aturdido recibe el doble: es la ventana para pelearlo.
  const amount = z.kind === 'tank' && z.mode === 'stunned' ? damage * 2 : damage;
  z.hp -= amount;
  z.hitFlash = 0.12;
  const heavy = z.kind === 'tank' ? 0.15 : 1;
  z.knockX += knockX * heavy;
  z.knockY += knockY * heavy;
  z.stagger = Math.max(z.stagger, stagger * heavy);
  state.events.push({ type: 'blood', x: z.x, y: z.y });
  // Golpearlo lo despierta aunque no te haya visto.
  if (z.mode !== 'charge' && z.mode !== 'stunned') {
    z.mode = 'chase';
    z.lastSeenAt = state.time;
  }
  if (z.hp <= 0) {
    state.stats.kills++;
    state.corpses.push({ x: z.x, y: z.y, facing: z.facing, kind: z.kind });
    if (state.corpses.length > 300) state.corpses.shift();
    if (z.kind === 'tank') state.events.push({ type: 'message', text: '¡Cayó el tanque!', tone: 'good' });
    return true;
  }
  return false;
}

export function updateZombies(state: GameState, rt: ZombieRuntime, dt: number): void {
  // Los muertos (los mató el combate en este paso) salen de la lista.
  if (state.zombies.some((z) => z.hp <= 0)) state.zombies = state.zombies.filter((z) => z.hp > 0);

  const { grid } = rt.city;
  const player = state.player;
  const zombies = state.zombies;
  rt.hash.rebuild(zombies);
  const light = flashlightPower(state.flashlight, state.time);
  const sight = SIGHT_DARK + (SIGHT_LIT - SIGHT_DARK) * light;
  const flow = { x: 0, y: 0 };
  let pushPlayerX = 0;
  let pushPlayerY = 0;

  for (let i = 0; i < zombies.length; i++) {
    const z = zombies[i];
    z.prevX = z.x;
    z.prevY = z.y;
    z.attackCooldown -= dt;
    z.hitFlash = Math.max(0, z.hitFlash - dt);
    z.stagger = Math.max(0, z.stagger - dt);

    const toX = player.x - z.x;
    const toY = player.y - z.y;
    const dist = Math.hypot(toX, toY);
    const asleep = dist > SLEEP_DISTANCE && (z.mode === 'idle' || z.mode === 'wander');
    if (asleep && z.knockX === 0 && z.knockY === 0) continue;

    // --- Pensar (6 veces por segundo) -------------------------------------------------------
    if ((state.tick + z.id) % THINK_EVERY === 0) think(state, rt, z, dist, toX, toY, sight);

    // --- Velocidad deseada según el modo ----------------------------------------------------
    let vx = 0;
    let vy = 0;
    const stats = STATS[z.kind];
    if (z.stagger <= 0) {
      switch (z.mode) {
        case 'chase':
          if (z.seesPlayer || dist < 1.5 || !rt.field.direction(z.x, z.y, flow)) {
            vx = (toX / (dist || 1)) * z.speed;
            vy = (toY / (dist || 1)) * z.speed;
          } else {
            vx = flow.x * z.speed;
            vy = flow.y * z.speed;
          }
          break;
        case 'investigate': {
          const tx = z.targetX - z.x;
          const ty = z.targetY - z.y;
          const td = Math.hypot(tx, ty);
          if (td > 1.5) {
            // Hacia el ruido: en línea recta si se ve, o por el campo de flujo si hay edificios entre medio.
            const speed = z.speed * 0.75;
            if (lineOfSightCached(rt, z, z.targetX, z.targetY, state.tick) || !rt.field.direction(z.x, z.y, flow)) {
              vx = (tx / td) * speed;
              vy = (ty / td) * speed;
            } else {
              vx = flow.x * speed;
              vy = flow.y * speed;
            }
          }
          break;
        }
        case 'wander':
          vx = Math.cos(z.facing) * WANDER_SPEED;
          vy = Math.sin(z.facing) * WANDER_SPEED;
          break;
        case 'return': {
          const hx = z.homeX - z.x;
          const hy = z.homeY - z.y;
          const hd = Math.hypot(hx, hy);
          if (hd < 1) {
            z.mode = 'idle';
          } else {
            vx = (hx / hd) * stats.minSpeed * 0.8;
            vy = (hy / hd) * stats.minSpeed * 0.8;
          }
          break;
        }
        case 'charge':
          vx = Math.cos(z.facing) * CHARGE_SPEED;
          vy = Math.sin(z.facing) * CHARGE_SPEED;
          z.timer -= dt;
          if (z.timer <= 0) startStun(z, 0.6);
          break;
        case 'stunned':
          z.timer -= dt;
          if (z.timer <= 0) {
            z.mode = 'chase';
            z.timer = CHARGE_COOLDOWN;
          }
          break;
        case 'idle':
          break;
      }
    }

    // Girar el cuerpo hacia donde camina (salvo en la embestida, que va recta).
    if (z.mode !== 'charge' && vx * vx + vy * vy > 0.04) z.facing = turnToward(z.facing, Math.atan2(vy, vx), 7 * dt);

    // --- Separación: los zombies no se atraviesan entre sí ----------------------------------
    let sepX = 0;
    let sepY = 0;
    rt.hash.query(z.x, z.y, z.radius + 1, (j) => {
      if (j === i) return;
      const o = zombies[j];
      const dx = z.x - o.x;
      const dy = z.y - o.y;
      const minDist = z.radius + o.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist || d2 === 0) return;
      const d = Math.sqrt(d2);
      // El más pesado empuja más: un tanque aparta a los caminantes, no al revés.
      const share = o.radius / (z.radius + o.radius);
      sepX += (dx / d) * (minDist - d) * share;
      sepY += (dy / d) * (minDist - d) * share;
    });

    // --- Mover con colisión contra la grilla ------------------------------------------------
    let mx = (vx + z.knockX) * dt + sepX * 0.5;
    let my = (vy + z.knockY) * dt + sepY * 0.5;
    // La colisión supone pasos menores al radio; limitamos el desplazamiento por paso.
    const maxStep = z.radius * 0.9;
    const step = Math.hypot(mx, my);
    if (step > maxStep) {
      mx *= maxStep / step;
      my *= maxStep / step;
    }
    const before = { x: z.x, y: z.y };
    const moved = moveCircle(grid, z.x, z.y, z.radius, mx, my);
    z.x = moved.x;
    z.y = moved.y;
    const decay = Math.exp(-8 * dt);
    z.knockX = Math.abs(z.knockX) < 0.05 ? 0 : z.knockX * decay;
    z.knockY = Math.abs(z.knockY) < 0.05 ? 0 : z.knockY * decay;

    // Si queríamos avanzar y casi no nos movimos, chocamos con algo.
    const wanted = Math.hypot(vx, vy) * dt;
    const blocked = wanted > 0.005 && Math.hypot(z.x - before.x, z.y - before.y) < wanted * 0.3;
    if (blocked && z.mode === 'wander') z.facing = random(state) * Math.PI * 2;
    if (blocked && z.mode === 'charge') {
      // El tanque se estrella contra la pared y queda aturdido.
      startStun(z, CHARGE_STUN);
      state.events.push({ type: 'message', text: 'El tanque se estrelló: ¡está aturdido!', tone: 'good' });
    }

    // --- Contacto con el jugador ------------------------------------------------------------
    const px = player.x - z.x;
    const py = player.y - z.y;
    const pd = Math.hypot(px, py);
    const touch = z.radius + PLAYER_RADIUS;
    if (pd < touch && pd > 0) {
      // Se empujan: el zombie retrocede y el jugador también un poco (una horda te encierra).
      const overlap = touch - pd;
      const fixed = moveCircle(grid, z.x, z.y, z.radius, (-px / pd) * overlap * 0.7, (-py / pd) * overlap * 0.7);
      z.x = fixed.x;
      z.y = fixed.y;
      pushPlayerX += (px / pd) * overlap * 0.3;
      pushPlayerY += (py / pd) * overlap * 0.3;
    }

    if (z.mode === 'charge' && pd < touch + 0.3) {
      hurtPlayer(state, CHARGE_DAMAGE);
      player.knockX = (px / (pd || 1)) * 14;
      player.knockY = (py / (pd || 1)) * 14;
      startStun(z, 0.9);
    } else if (
      z.stagger <= 0 &&
      z.mode !== 'stunned' &&
      z.mode !== 'charge' &&
      pd < touch + STATS[z.kind].reach &&
      z.attackCooldown <= 0
    ) {
      hurtPlayer(state, STATS[z.kind].damage);
      z.attackCooldown = STATS[z.kind].cooldown;
      z.mode = 'chase';
      z.lastSeenAt = state.time;
      if (z.kind === 'tank') {
        player.knockX = (px / (pd || 1)) * 9;
        player.knockY = (py / (pd || 1)) * 9;
      }
    }
  }

  if (pushPlayerX !== 0 || pushPlayerY !== 0) {
    const limit = PLAYER_RADIUS * 0.9;
    const length = Math.hypot(pushPlayerX, pushPlayerY);
    const scale = length > limit ? limit / length : 1;
    const moved = moveCircle(grid, player.x, player.y, PLAYER_RADIUS, pushPlayerX * scale, pushPlayerY * scale);
    player.x = moved.x;
    player.y = moved.y;
  }
}

function think(
  state: GameState,
  rt: ZombieRuntime,
  z: Zombie,
  dist: number,
  toX: number,
  toY: number,
  sight: number,
): void {
  const thinkDt = THINK_EVERY / 60;
  const range = z.kind === 'tank' ? sight + 2 : sight;
  // Primero lo barato (distancia y ángulo); el rayo, solo si hace falta.
  const inCone =
    dist < 3 ||
    z.mode === 'chase' ||
    z.mode === 'investigate' ||
    angleBetween(z.facing, Math.atan2(toY, toX)) < VIEW_CONE / 2;
  z.seesPlayer = dist < range && inCone && lineOfSight(rt.city.grid, z.x, z.y, state.player.x, state.player.y);

  if (z.seesPlayer) {
    z.lastSeenAt = state.time;
    z.targetX = state.player.x;
    z.targetY = state.player.y;
    if (z.mode !== 'chase' && z.mode !== 'charge' && z.mode !== 'stunned') {
      z.mode = 'chase';
      z.timer = z.kind === 'tank' ? 1.5 : 0;
    }
  }

  switch (z.mode) {
    case 'chase': {
      const horde = state.time < z.hordeUntil;
      if (!z.seesPlayer && !horde && state.time - z.lastSeenAt > LOSE_INTEREST) {
        z.mode = 'investigate';
        z.timer = 6;
      }
      if (z.kind === 'tank') {
        z.timer -= thinkDt;
        // Embestida: si te ve en línea recta, a distancia media, y ya se recuperó de la anterior.
        if (z.seesPlayer && z.timer <= 0 && dist > CHARGE_MIN && dist < CHARGE_MAX) {
          z.mode = 'charge';
          z.facing = Math.atan2(toY, toX);
          z.timer = CHARGE_TIME;
          state.events.push({ type: 'message', text: '¡El tanque embiste!', tone: 'danger' });
        }
        // Si te alejas mucho, vuelve a su puesto a vigilar.
        if (!z.seesPlayer && dist > 30 && state.time - z.lastSeenAt > 8) z.mode = 'return';
      }
      break;
    }
    case 'investigate':
      z.timer -= thinkDt;
      if (z.timer <= 0) {
        z.mode = z.kind === 'tank' ? 'return' : 'wander';
        z.timer = randomRange(state, 2, 6);
      }
      break;
    case 'idle':
    case 'wander':
      if (z.kind === 'tank') break;
      z.timer -= thinkDt;
      if (z.timer <= 0) {
        z.mode = random(state) < 0.55 ? 'wander' : 'idle';
        z.timer = randomRange(state, 2, 7);
        if (z.mode === 'wander') z.facing = random(state) * Math.PI * 2;
      }
      break;
  }
}

/** Caché simple: la línea de visión al objetivo de investigación solo se recalcula al pensar. */
const losCache = new Map<number, boolean>();
function lineOfSightCached(rt: ZombieRuntime, z: Zombie, x: number, y: number, tick: number): boolean {
  if ((tick + z.id) % THINK_EVERY === 0 || !losCache.has(z.id)) {
    losCache.set(z.id, lineOfSight(rt.city.grid, z.x, z.y, x, y));
    if (losCache.size > 2000) losCache.clear();
  }
  return losCache.get(z.id)!;
}

function startStun(z: Zombie, seconds: number): void {
  z.mode = 'stunned';
  z.timer = seconds;
}

export function hurtPlayer(state: GameState, damage: number): void {
  if (state.status !== 'playing') return;
  state.player.hp = Math.max(0, state.player.hp - damage);
  state.player.hurtTimer = 0;
  state.events.push({ type: 'hurt', damage });
}

function turnToward(current: number, target: number, maxStep: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + Math.max(-maxStep, Math.min(maxStep, diff));
}

// --- Hordas -------------------------------------------------------------------------------

/**
 * danger: 0..1, qué tan peligrosa es la zona donde está el jugador. Más peligro, hordas más
 * seguidas y más grandes.
 */
export function updateHordes(state: GameState, rt: ZombieRuntime, dt: number, danger: number): void {
  state.hordeTimer -= dt;
  state.noiseHeat = Math.max(0, state.noiseHeat - 0.12 * dt);

  const byNoise = state.noiseHeat >= HORDE_HEAT_LIMIT;
  if (state.hordeTimer > 0 && !byNoise) return;
  state.hordeTimer = HORDE_INTERVAL * (1 - 0.45 * danger);
  state.noiseHeat = 0;
  const size = Math.round(14 + 14 * danger);
  if (spawnHorde(state, rt, size)) {
    state.events.push({
      type: 'message',
      text: byNoise ? '¡El ruido atrajo una horda!' : '¡Se acerca una horda!',
      tone: 'danger',
    });
  }
}

/** Crea una horda fuera de la vista del jugador, a una distancia (caminando) de 26 a 44 tiles. */
export function spawnHorde(state: GameState, rt: ZombieRuntime, size: number): boolean {
  const { grid } = rt.city;
  const count = Math.min(size, MAX_ZOMBIES - state.zombies.length);
  if (count <= 0) return false;

  for (let attempt = 0; attempt < 400; attempt++) {
    const x = Math.floor(random(state) * grid.width) + 0.5;
    const y = Math.floor(random(state) * grid.height) + 0.5;
    const d = rt.field.distanceAt(x, y);
    if (d < 26 || d > 44) continue;
    if (lineOfSight(grid, state.player.x, state.player.y, x, y)) continue;

    let placed = 0;
    for (let k = 0; k < count * 6 && placed < count; k++) {
      const zx = x + randomRange(state, -3, 3);
      const zy = y + randomRange(state, -3, 3);
      if (isSolid(grid, Math.floor(zx), Math.floor(zy)) || rt.field.distanceAt(zx, zy) < 0) continue;
      const z = createZombie(state, zx, zy, 'walker');
      // Un movimiento nulo aplica la "depenetración": si quedó pegado a un muro, lo saca.
      const fixed = moveCircle(grid, zx, zy, z.radius, 0, 0);
      z.x = z.prevX = fixed.x;
      z.y = z.prevY = fixed.y;
      z.mode = 'chase';
      z.lastSeenAt = state.time;
      z.hordeUntil = state.time + HORDE_CHASE_TIME;
      state.zombies.push(z);
      placed++;
    }
    state.stats.hordes++;
    return placed > 0;
  }
  return false;
}
