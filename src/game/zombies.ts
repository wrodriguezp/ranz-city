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
//  - OÍDO: los ruidos (disparos, golpes, pisadas) atraen a los zombies en un radio (makeNoise).
//    Ojo: van al LUGAR del ruido, no a ti. Si disparas y te mueves, llegan a donde estabas.
//    Mientras más lejos lo oyeron, más impreciso es el punto al que van.
//  - LUZ: bajo un farol te ven de lejos aunque vayas agachado (ver world/streetLights.ts).
//  - ALERTA EN CADENA: si 3 o más te persiguen, gruñen y ese ruido llama a los de alrededor.
//  - HORDAS: cada cierto tiempo (o si haces mucho ruido) aparece un grupo fuera de tu vista que
//    va al último ruido fuerte y peina la zona. Solo te persigue de verdad si te VE.
//
// Para llegar a un punto rodeando edificios se usa un campo de flujo (flowField.ts). Hay dos:
// uno hacia el jugador y otro hacia el último ruido fuerte. Un zombie que investiga usa el
// que corresponda a su objetivo; así un ruido lejano (una granada, una alarma) los aleja de ti.

import type { City } from '../world/city';
import { lightAt } from '../world/streetLights';
import { WEATHER_EFFECTS } from '../world/weather';
import { isSolid, moveCircle } from './collision';
import { queueBlast, throwAcid, throwRock } from './explosives';
import { flashlightPower } from './flashlight';
import type { FlowField } from './flowField';
import { PLAYER_RADIUS } from './player';
import { random, randomRange } from './random';
import type { SpatialHash } from './spatialHash';
import { LIMB_ARM_L, LIMB_ARM_R, LIMB_LEGS, type GameState, type Zombie, type ZombieKind, type ZombieRole } from './state';
import { angleBetween, lineOfSight } from './visibility';

/** Lo que necesita la IA además del estado: el mundo y estructuras auxiliares que se recalculan. */
export interface ZombieRuntime {
  city: City;
  field: FlowField;
  /** Campo de flujo hacia el último ruido fuerte (ver makeNoise). */
  noiseField: FlowField;
  /** Campo de flujo hacia donde VA el jugador (un poco adelante): lo usan los flanqueadores. */
  flankField: FlowField;
  hash: SpatialHash;
}

/** Desde este radio un ruido cuenta como "fuerte": mueve el campo de flujo de ruido y atrae hordas. */
const LOUD_NOISE = 15;
/** Si el objetivo está a menos de esto del origen de un campo de flujo, se usa ese campo. */
const FIELD_SNAP = 10;

const STATS: Record<
  ZombieKind,
  { hp: number; radius: number; minSpeed: number; maxSpeed: number; damage: number; cooldown: number; reach: number }
> = {
  walker: { hp: 100, radius: 0.35, minSpeed: 2.6, maxSpeed: 3.9, damage: 7, cooldown: 1.1, reach: 0.45 },
  runner: { hp: 50, radius: 0.32, minSpeed: 5.4, maxSpeed: 6.2, damage: 5, cooldown: 0.75, reach: 0.4 },
  bloater: { hp: 140, radius: 0.55, minSpeed: 1.7, maxSpeed: 2.1, damage: 10, cooldown: 1.4, reach: 0.45 },
  screamer: { hp: 70, radius: 0.33, minSpeed: 2.8, maxSpeed: 3.3, damage: 4, cooldown: 1, reach: 0.4 },
  spitter: { hp: 80, radius: 0.34, minSpeed: 2.6, maxSpeed: 3.0, damage: 4, cooldown: 1.1, reach: 0.4 },
  tank: { hp: 1100, radius: 0.8, minSpeed: 2.1, maxSpeed: 2.1, damage: 30, cooldown: 1.6, reach: 0.55 },
};

/** Gravedad para los zombies que salen volando (igual que la de las granadas). */
const AIR_GRAVITY = 30;
/** El gritón: cuánto se oye su grito, cada cuánto puede gritar y el tamaño de la horda que llama. */
const SCREAM_NOISE = 32;
const SCREAM_COOLDOWN = 22;
const SCREAM_HORDE = 8;
/** La roca del tanque: distancias en las que la tira, cuánto tarda en prepararla y cada cuánto. */
const ROCK_MIN = 9;
const ROCK_MAX = 22;
const ROCK_WINDUP = 1.25;
const ROCK_COOLDOWN = 8;
/** La embestida arrolla a los zombies que se cruza: los lanza por el aire. */
const CHARGE_LAUNCH_DAMAGE = 45;

const WANDER_SPEED = 0.7;
const THINK_EVERY = 10;
/** Más lejos que esto, los zombies que no persiguen ni se mueven: ahorra CPU y nadie lo nota. */
const SLEEP_DISTANCE = 48;
const SIGHT_DARK = 6;
const SIGHT_LIT = 19;
const VIEW_CONE = (150 * Math.PI) / 180;
/** Agachado te ven a esta fracción de la distancia normal (más chico = más difícil verte). */
const SNEAK_SIGHT = 0.55;
/** Bajo la luz plena de un farol te ven desde aquí (agachado, a LAMP_SNEAK de eso). */
const SIGHT_LAMP = 17;
const LAMP_SNEAK = 0.85;
/** Los de una horda vienen buscando: ven más lejos y te huelen de más cerca aunque vayas agachado. */
const HORDE_SIGHT = 1.3;
/** Alerta en cadena: cuántos persiguiendo, qué tan lejos se oye el gruñido y cada cuánto. */
const ALERT_PACK = 3;
const ALERT_NOISE = 24;
const ALERT_EVERY = 6;
/** El acechador no se mueve por ruidos más lejanos que esto; al verte, arranca a esta velocidad. */
const AMBUSH_HEAR = 9;
const AMBUSH_BURST = 1.6;
const AMBUSH_SPEED = 1.8;
/**
 * El escupidor: se queda a esta distancia de ti (ni muy cerca ni muy lejos) y escupe ácido cada
 * tanto. La bola tarda en llegar y marca dónde cae: hay que moverse.
 */
const SPIT_MIN = 4;
const SPIT_MAX = 13;
const SPIT_KEEP_NEAR = 6;
const SPIT_KEEP_FAR = 9.5;
const SPIT_COOLDOWN = 4.5;
/** Sin piernas se arrastra a esta fracción de su velocidad. Sin un brazo pega a esta fracción. */
const CRAWL_SPEED = 0.35;
const ONE_ARM_DAMAGE = 0.6;
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
const HORDE_HEAT_LIMIT = 18;
const HORDE_CHASE_TIME = 75;

export function createZombie(state: GameState, x: number, y: number, kind: ZombieKind): Zombie {
  const stats = STATS[kind];
  return {
    id: state.nextZombieId++,
    kind,
    role: pickRole(state, kind),
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
    air: 0,
    airV: 0,
    ability: kind === 'tank' ? 4 : kind === 'spitter' ? 2 : 0,
    limbs: 0,
    burn: 0,
  };
}

/**
 * Reparto de roles: la mayoría persigue o rodea; algunos flanquean. Los acechadores se eligen
 * aparte (al armar la partida, entre los que empiezan en un cruce).
 */
function pickRole(state: GameState, kind: ZombieKind): ZombieRole {
  if (kind === 'tank') return 'chaser';
  const r = random(state);
  if (kind === 'runner') return r < 0.6 ? 'chaser' : 'flanker';
  return r < 0.35 ? 'chaser' : r < 0.72 ? 'surround' : 'flanker';
}

/**
 * Lanza a un zombie por el aire: empujón horizontal (vx, vy) y velocidad hacia arriba (up).
 * Mientras vuela no ataca ni piensa en moverse; al caer queda aturdido un momento.
 * El tanque pesa demasiado: apenas se mueve.
 */
export function launchZombie(z: Zombie, vx: number, vy: number, up: number): void {
  const heavy = z.kind === 'tank' ? 0.1 : z.kind === 'bloater' ? 0.6 : 1;
  z.knockX += vx * heavy;
  z.knockY += vy * heavy;
  if (z.kind !== 'tank') {
    z.airV = Math.max(z.airV, up);
    z.air = Math.max(z.air, 0.01);
  }
}

export function initialHordeTimer(): number {
  return HORDE_FIRST;
}

/**
 * Un ruido en (x, y) que se oye hasta `radius` tiles. Los zombies que lo oyen van a INVESTIGAR
 * ese punto (no al jugador): si después te mueves en silencio, llegan a un lugar vacío.
 */
export function makeNoise(state: GameState, x: number, y: number, radius: number, rt?: ZombieRuntime): void {
  if (radius >= LOUD_NOISE) {
    state.lastNoise = { x, y, time: state.time };
    rt?.noiseField.update(x, y);
  }
  // La lluvia tapa los ruidos: se oyen a menos distancia.
  const heard = radius * WEATHER_EFFECTS[state.weather].hearing;
  for (const z of state.zombies) {
    // El tanque está "de guardia": oye menos.
    const r = z.kind === 'tank' ? heard * 0.6 : heard;
    const d = Math.hypot(z.x - x, z.y - y);
    if (d > r || z.mode === 'charge' || z.mode === 'stunned' || z.mode === 'throw') continue;
    // El que te persigue no se distrae con un ruido.
    if (z.mode === 'chase' && (z.seesPlayer || state.time - z.lastSeenAt < 3)) continue;
    // El acechador espera en su cruce: solo un ruido cercano lo saca de ahí.
    if (z.role === 'ambusher' && z.mode === 'idle' && d > AMBUSH_HEAR) continue;
    z.mode = 'investigate';
    z.timer = 9;
    // Apuntan al ruido con un error que crece con la distancia: de lejos solo saben "por ahí".
    const error = 1 + d * 0.12;
    z.targetX = x + randomRange(state, -error, error);
    z.targetY = y + randomRange(state, -error, error);
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
  options: DamageOptions = {},
): boolean {
  if (z.hp <= 0) return false;
  // Un tanque aturdido recibe el doble: es la ventana para pelearlo.
  const amount = z.kind === 'tank' && z.mode === 'stunned' ? damage * 2 : damage;
  z.hp -= amount;
  z.hitFlash = options.burn ? Math.max(z.hitFlash, 0.04) : 0.12;
  const heavy = z.kind === 'tank' ? 0.15 : 1;
  z.knockX += knockX * heavy;
  z.knockY += knockY * heavy;
  z.stagger = Math.max(z.stagger, stagger * heavy);
  const knock = Math.hypot(knockX, knockY) || 1;
  const dirX = knockX / knock;
  const dirY = knockY / knock;

  // Desmembramiento (nunca al tanque): un arma con filo, una escopeta de cerca o una explosión
  // pueden arrancar un miembro. Decapitar mata; sin brazos no ataca; sin piernas se arrastra.
  let beheaded = false;
  if (z.kind !== 'tank') {
    if (options.behead || (z.hp <= 0 && options.sever && random(state) < options.sever * 0.5)) {
      beheaded = true;
      z.hp = Math.min(z.hp, 0);
      state.events.push({ type: 'limb', x: z.x, y: z.y, dirX, dirY, part: 'head', side: 0, kind: z.kind, facing: z.facing });
    } else if (z.hp > 0 && options.sever && random(state) < options.sever) {
      sever(state, z, dirX, dirY);
    }
  }

  const killed = z.hp <= 0;
  if (!options.quiet || killed) {
    state.events.push({ type: 'blood', x: z.x, y: z.y });
    state.events.push({
      type: 'hit',
      x: z.x,
      y: z.y,
      dirX,
      dirY,
      damage: Math.round(amount),
      killed,
      // Revienta si lo dice el arma, o si el golpe fue mucho más de lo que le quedaba.
      // (Decapitado o quemado, no: queda entero en el suelo.)
      gib: killed && !beheaded && !options.burn && (options.gib === true || -z.hp > z.maxHp * 0.6 || z.kind === 'bloater'),
      crit: options.crit === true || beheaded,
      kind: z.kind,
    });
  }
  // Golpearlo lo despierta aunque no te haya visto. De cerca sabe de dónde vino; de lejos
  // (una bala desde la oscuridad) solo sabe la dirección aproximada: va a investigar.
  // El fuego no le dice nada de dónde estás.
  if (z.mode !== 'charge' && z.mode !== 'stunned' && z.mode !== 'throw' && !options.burn) {
    const d = Math.hypot(state.player.x - z.x, state.player.y - z.y);
    if (d < 12 || z.seesPlayer) {
      z.mode = 'chase';
      z.lastSeenAt = state.time;
    } else {
      z.mode = 'investigate';
      z.timer = 9;
      z.targetX = state.player.x + randomRange(state, -3, 3);
      z.targetY = state.player.y + randomRange(state, -3, 3);
    }
  }
  if (z.hp <= 0) {
    state.stats.kills++;
    // El hinchado revienta: la explosión sale un instante después (por la cola de explosiones).
    if (z.kind === 'bloater') queueBlast(state, z.x, z.y, 'bloater', 0.05);
    state.corpses.push({ x: z.x, y: z.y, facing: z.facing, kind: z.kind });
    if (state.corpses.length > 300) state.corpses.shift();
    if (z.kind === 'tank') state.events.push({ type: 'message', text: '¡Cayó el tanque!', tone: 'good' });
    return true;
  }
  return false;
}

export interface DamageOptions {
  crit?: boolean;
  gib?: boolean;
  /** Probabilidad de arrancar un miembro (y, si lo mata, la cabeza). */
  sever?: number;
  /** Lo decapita sí o sí (ejecución con filo, crítico con filo). */
  behead?: boolean;
  /** Sin sangre ni número de daño salvo que muera (lanzallamas, fuego): serían cientos por segundo. */
  quiet?: boolean;
  /** Daño por quemadura: no lo despierta hacia ti ni lo empuja. */
  burn?: boolean;
}

/** Arranca un brazo (o las piernas, si ya no le quedan brazos o tuvo mala suerte). */
function sever(state: GameState, z: Zombie, dirX: number, dirY: number): void {
  const armsLeft = [LIMB_ARM_L, LIMB_ARM_R].filter((bit) => (z.limbs & bit) === 0);
  const legs = (z.limbs & LIMB_LEGS) === 0 && (armsLeft.length === 0 || random(state) < 0.3);
  if (legs) {
    z.limbs |= LIMB_LEGS;
    z.stagger = Math.max(z.stagger, 0.8);
    state.events.push({ type: 'limb', x: z.x, y: z.y, dirX, dirY, part: 'legs', side: 0, kind: z.kind, facing: z.facing });
  } else if (armsLeft.length > 0) {
    const bit = armsLeft[Math.floor(random(state) * armsLeft.length)];
    z.limbs |= bit;
    state.events.push({ type: 'limb', x: z.x, y: z.y, dirX, dirY, part: 'arm', side: bit === LIMB_ARM_L ? -1 : 1, kind: z.kind, facing: z.facing });
  } else {
    return;
  }
  state.events.push({ type: 'sfx', name: 'sever', x: z.x, y: z.y });
}

export function updateZombies(state: GameState, rt: ZombieRuntime, dt: number): void {
  // Los muertos (los mató el combate en este paso) salen de la lista.
  if (state.zombies.some((z) => z.hp <= 0)) state.zombies = state.zombies.filter((z) => z.hp > 0);

  const { grid } = rt.city;
  const player = state.player;
  const zombies = state.zombies;
  rt.hash.rebuild(zombies);
  const light = flashlightPower(state.flashlight, state.time);
  // La niebla (y algo la lluvia) acorta la vista de todos.
  const weatherSight = WEATHER_EFFECTS[state.weather].sight;
  const sight = (SIGHT_DARK + (SIGHT_LIT - SIGHT_DARK) * light) * weatherSight;
  // Luz de los faroles donde estás parado: bajo un farol te ven aunque tengas la linterna apagada.
  const lampSight = SIGHT_LAMP * lightAt(rt.city.lights, player.x, player.y, state.time) * weatherSight;
  const playerVX = (player.x - player.prevX) / dt;
  const playerVY = (player.y - player.prevY) / dt;
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
    if (asleep && z.knockX === 0 && z.knockY === 0 && z.air === 0) continue;

    // --- Vuelo: si una explosión o el tanque lo lanzó, sigue el arco hasta caer -------------
    const flying = z.air > 0;
    if (flying) {
      z.airV -= AIR_GRAVITY * dt;
      z.air += z.airV * dt;
      if (z.air <= 0) {
        // Aterrizaje: queda en el suelo aturdido un rato.
        z.air = 0;
        z.airV = 0;
        z.stagger = Math.max(z.stagger, 0.7);
      }
    }

    // --- Pensar (6 veces por segundo) -------------------------------------------------------
    if (!flying && (state.tick + z.id) % THINK_EVERY === 0) think(state, rt, z, dist, toX, toY, sight, lampSight);

    // --- Velocidad deseada según el modo ----------------------------------------------------
    let vx = 0;
    let vy = 0;
    const stats = STATS[z.kind];
    if (z.stagger <= 0 && !flying) {
      switch (z.mode) {
        case 'chase': {
          // El acechador arranca con todo cuando te ve (ability = segundos de arranque que quedan).
          const speed = z.role === 'ambusher' && z.ability > 0 ? z.speed * AMBUSH_SPEED : z.speed;
          if (dist < 1.6) {
            vx = (toX / (dist || 1)) * speed;
            vy = (toY / (dist || 1)) * speed;
          } else if (z.seesPlayer) {
            // Te ve: va en línea recta, pero no todos al mismo punto (ver chaseGoal).
            const goal = chaseGoal(rt, z, player.x, player.y, dist, playerVX, playerVY);
            const gx = goal.x - z.x;
            const gy = goal.y - z.y;
            const gd = Math.hypot(gx, gy) || 1;
            vx = (gx / gd) * speed;
            vy = (gy / gd) * speed;
          } else if (z.role === 'flanker' && dist > 6 && rt.flankField.direction(z.x, z.y, flow)) {
            // No te ve: el flanqueador rodea la manzana hacia donde vas, no hacia donde estás.
            vx = flow.x * speed;
            vy = flow.y * speed;
          } else if (rt.field.direction(z.x, z.y, flow)) {
            vx = flow.x * speed;
            vy = flow.y * speed;
          } else {
            vx = (toX / (dist || 1)) * speed;
            vy = (toY / (dist || 1)) * speed;
          }
          break;
        }
        case 'investigate': {
          const tx = z.targetX - z.x;
          const ty = z.targetY - z.y;
          const td = Math.hypot(tx, ty);
          if (td > 1.5) {
            // Hacia el ruido: en línea recta si se ve, o por el campo de flujo que lleve a ese
            // punto si hay edificios entre medio. Las hordas caminan más decididas.
            const speed = z.speed * (state.time < z.hordeUntil ? 0.9 : 0.75);
            const field = fieldFor(rt, state, z.targetX, z.targetY);
            if (lineOfSightCached(rt, z, z.targetX, z.targetY, state.tick) || !field || !field.direction(z.x, z.y, flow)) {
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
          trample(state, rt, z, i);
          break;
        case 'throw':
          // Preparando la roca: quieto, mirando al jugador. Al terminar, la tira.
          z.facing = turnToward(z.facing, Math.atan2(toY, toX), 5 * dt);
          z.timer -= dt;
          if (z.timer <= 0) {
            // Apunta a donde vas a estar (un poco adelantado según cómo te mueves), con error.
            const lead = 0.35;
            const tx = player.x + (player.x - player.prevX) * 60 * lead + randomRange(state, -1, 1);
            const ty = player.y + (player.y - player.prevY) * 60 * lead + randomRange(state, -1, 1);
            throwRock(state, z.x, z.y, tx, ty);
            z.mode = 'chase';
            z.ability = ROCK_COOLDOWN;
          }
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

    // El escupidor no se te pega: si te ve, mantiene la distancia y se mueve de costado.
    if (z.kind === 'spitter' && z.mode === 'chase' && z.seesPlayer && z.stagger <= 0 && !flying && dist < SPIT_MAX) {
      const ux = toX / (dist || 1);
      const uy = toY / (dist || 1);
      const side = z.id % 2 === 0 ? 1 : -1;
      const toward = dist < SPIT_KEEP_NEAR ? -0.9 : dist > SPIT_KEEP_FAR ? 1 : 0;
      vx = (ux * toward - uy * side * 0.45) * z.speed;
      vy = (uy * toward + ux * side * 0.45) * z.speed;
      z.facing = turnToward(z.facing, Math.atan2(toY, toX), 6 * dt);
    }
    // Sin piernas se arrastra.
    if (z.limbs & LIMB_LEGS) {
      vx *= CRAWL_SPEED;
      vy *= CRAWL_SPEED;
    }

    z.ability -= dt;
    // Girar el cuerpo hacia donde camina (salvo en la embestida, que va recta).
    if (z.mode !== 'charge' && !(z.kind === 'spitter' && z.seesPlayer) && vx * vx + vy * vy > 0.04) z.facing = turnToward(z.facing, Math.atan2(vy, vx), 7 * dt);

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
    // En el aire casi no hay roce: el que sale volando llega lejos.
    const decay = Math.exp((flying ? -1.5 : -8) * dt);
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
    // Durante el dash el jugador se escurre entre ellos: no lo empujan.
    if (pd < touch && pd > 0 && !flying && player.air < 0.5 && player.dashTime <= 0) {
      // Se empujan: el zombie retrocede y el jugador también un poco (una horda te encierra).
      const overlap = touch - pd;
      const fixed = moveCircle(grid, z.x, z.y, z.radius, (-px / pd) * overlap * 0.7, (-py / pd) * overlap * 0.7);
      z.x = fixed.x;
      z.y = fixed.y;
      pushPlayerX += (px / pd) * overlap * 0.3;
      pushPlayerY += (py / pd) * overlap * 0.3;
    }

    if (z.mode === 'charge' && pd < touch + 0.3 && player.invuln <= 0) {
      hurtPlayer(state, CHARGE_DAMAGE);
      // Te manda a volar: hacia adelante (por donde venía el tanque) y un poco hacia el costado.
      const fx = Math.cos(z.facing);
      const fy = Math.sin(z.facing);
      player.knockX = fx * 13 + (px / (pd || 1)) * 6;
      player.knockY = fy * 13 + (py / (pd || 1)) * 6;
      player.airV = 7;
      startStun(z, 0.9);
    } else if (
      !flying &&
      z.stagger <= 0 &&
      z.mode !== 'stunned' &&
      z.mode !== 'charge' &&
      pd < touch + STATS[z.kind].reach &&
      z.attackCooldown <= 0 &&
      // Sin brazos no puede agarrarte: solo empuja.
      (z.limbs & (LIMB_ARM_L | LIMB_ARM_R)) !== (LIMB_ARM_L | LIMB_ARM_R)
    ) {
      const oneArm = (z.limbs & (LIMB_ARM_L | LIMB_ARM_R)) !== 0;
      hurtPlayer(state, Math.round(STATS[z.kind].damage * (oneArm ? ONE_ARM_DAMAGE : 1)));
      z.attackCooldown = STATS[z.kind].cooldown;
      z.mode = 'chase';
      z.lastSeenAt = state.time;
      if (z.kind === 'tank') {
        player.knockX = (px / (pd || 1)) * 9;
        player.knockY = (py / (pd || 1)) * 9;
      }
    }
  }

  alertPack(state, rt, dt);

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
  lampSight: number,
): void {
  const thinkDt = THINK_EVERY / 60;
  const sneaking = state.player.sneaking;
  const hunting = state.time < z.hordeUntil;
  // Dos fuentes de luz te delatan: tu linterna y los faroles. Vale la que más te expone.
  // Agacharse sirve mucho en la oscuridad y poco bajo un farol.
  let range = Math.max(
    (z.kind === 'tank' ? sight + 2 : sight) * (sneaking ? SNEAK_SIGHT : 1),
    lampSight * (sneaking ? LAMP_SNEAK : 1),
  );
  if (hunting) range *= HORDE_SIGHT;
  // Primero lo barato (distancia y ángulo); el rayo, solo si hace falta.
  // Muy cerca te "sienten" aunque no te miren, salvo que vayas agachado (a una horda que te
  // busca le cuesta menos: te huele).
  const inCone =
    dist < (sneaking ? (hunting ? 2.5 : 1.2) : 3) ||
    z.mode === 'chase' ||
    z.mode === 'investigate' ||
    angleBetween(z.facing, Math.atan2(toY, toX)) < VIEW_CONE / 2;
  z.seesPlayer = dist < range && inCone && lineOfSight(rt.city.grid, z.x, z.y, state.player.x, state.player.y);

  if (z.seesPlayer) {
    z.lastSeenAt = state.time;
    z.targetX = state.player.x;
    z.targetY = state.player.y;
    if (z.mode !== 'chase' && z.mode !== 'charge' && z.mode !== 'stunned' && z.mode !== 'throw') {
      state.events.push({ type: 'sfx', name: 'spotted', x: z.x, y: z.y });
      z.mode = 'chase';
      z.timer = z.kind === 'tank' ? 1.5 : 0;
      if (z.role === 'ambusher') z.ability = AMBUSH_BURST;
    }
    if (z.kind === 'screamer' && z.ability <= 0) scream(state, rt, z);
    if (z.kind === 'spitter' && z.ability <= 0 && dist > SPIT_MIN && dist < SPIT_MAX && z.stagger <= 0) {
      // Apunta un poco adelante de donde vas, con error: quedarse quieto es lo peor.
      const p = state.player;
      const lead = 0.5;
      const tx = p.x + (p.x - p.prevX) * 60 * lead + randomRange(state, -0.8, 0.8);
      const ty = p.y + (p.y - p.prevY) * 60 * lead + randomRange(state, -0.8, 0.8);
      throwAcid(state, z.x, z.y, tx, ty);
      z.ability = SPIT_COOLDOWN;
      z.stagger = 0.35;
    }
  }

  switch (z.mode) {
    case 'chase': {
      // Si te perdió de vista, va a la última posición donde te vio y busca por ahí.
      if (!z.seesPlayer && state.time - z.lastSeenAt > LOSE_INTEREST) {
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
          state.events.push({ type: 'sfx', name: 'roar', x: z.x, y: z.y });
        }
        // De lejos, si te ve, arranca un trozo de pavimento y te lo tira.
        if (z.mode === 'chase' && z.seesPlayer && z.ability <= 0 && dist > ROCK_MIN && dist < ROCK_MAX) {
          z.mode = 'throw';
          z.timer = ROCK_WINDUP;
          // El rugido avisa ANTES de que tire: hay más de un segundo para moverse.
          state.events.push({ type: 'sfx', name: 'roar', x: z.x, y: z.y });
          state.events.push({ type: 'message', text: '¡El tanque arranca un trozo de calle!', tone: 'danger' });
        }
        // Si te alejas mucho, vuelve a su puesto a vigilar.
        if (!z.seesPlayer && dist > 30 && state.time - z.lastSeenAt > 8) z.mode = 'return';
      }
      break;
    }
    case 'investigate': {
      const horde = state.time < z.hordeUntil;
      const arrived = Math.hypot(z.targetX - z.x, z.targetY - z.y) < 2;
      if (horde && arrived) {
        // La horda llegó y no hay nadie: peina la zona. Si hubo un ruido fuerte reciente, va
        // hacia él; si no, deambula por el barrio donde se te oyó por última vez.
        const recent = state.time - state.lastNoise.time < 10;
        const spread = recent ? 3 : 9;
        z.targetX = state.lastNoise.x + randomRange(state, -spread, spread);
        z.targetY = state.lastNoise.y + randomRange(state, -spread, spread);
        z.timer = 9;
        break;
      }
      z.timer -= thinkDt;
      if (z.timer <= 0 && !horde) {
        z.mode = z.kind === 'tank' ? 'return' : 'wander';
        z.timer = randomRange(state, 2, 6);
      }
      break;
    }
    case 'idle':
    case 'wander':
      if (z.kind === 'tank') break;
      // El acechador no deambula: espera agazapado en su cruce.
      if (z.role === 'ambusher') {
        z.mode = 'idle';
        break;
      }
      z.timer -= thinkDt;
      if (z.timer <= 0) {
        z.mode = random(state) < 0.55 ? 'wander' : 'idle';
        z.timer = randomRange(state, 2, 7);
        if (z.mode === 'wander') z.facing = random(state) * Math.PI * 2;
      }
      break;
  }
}

/**
 * A qué punto apunta un zombie que te VE. Si todos fueran derecho a ti, llegarían en fila por el
 * mismo lado. Así:
 *  - envolvente: apunta a un punto a tu costado (rota la dirección de llegada entre 30 y 65°),
 *    cada uno hacia su lado según su id. Entre varios te rodean. Ya encima tuyo, va directo.
 *  - flanqueador: apunta a donde vas a estar en un momento (tu velocidad por el tiempo que tarda
 *    en llegar, hasta 1.5 s): si huyes en línea recta, te sale al paso.
 *  - perseguidor y acechador: directo a ti.
 */
function chaseGoal(
  rt: ZombieRuntime,
  z: Zombie,
  px: number,
  py: number,
  dist: number,
  vx: number,
  vy: number,
): { x: number; y: number } {
  let gx = px;
  let gy = py;
  if (z.role === 'surround' && dist > 2.4) {
    const sign = z.id % 2 === 0 ? 1 : -1;
    const angle = Math.atan2(z.y - py, z.x - px) + sign * (0.5 + ((z.id * 0.618) % 1) * 0.6);
    const r = Math.min(dist * 0.6, 3.5);
    gx = px + Math.cos(angle) * r;
    gy = py + Math.sin(angle) * r;
  } else if (z.role === 'flanker' && dist > 4) {
    const t = Math.min(1.5, dist / z.speed);
    gx = px + vx * t;
    gy = py + vy * t;
  }
  // Si el punto cae dentro de un edificio, mejor ir directo.
  if (isSolid(rt.city.grid, Math.floor(gx), Math.floor(gy))) return { x: px, y: py };
  return { x: gx, y: gy };
}

/**
 * Alerta en cadena. Un zombie solo no avisa a nadie; pero si 3 o más te están viendo, sus
 * gruñidos se oyen lejos y los de las cuadras de alrededor vienen a mirar (a tu posición, con
 * error). Así una pelea en plena calle no pasa desapercibida, y esconderse rápido no alcanza:
 * hay que cortar la línea de visión ANTES de que se junten.
 */
function alertPack(state: GameState, rt: ZombieRuntime, dt: number): void {
  state.alert.timer -= dt;
  if (state.alert.timer > 0) return;
  let pack = 0;
  for (const z of state.zombies) if (z.mode === 'chase' && z.seesPlayer && z.hp > 0) pack++;
  if (pack < ALERT_PACK) return;
  state.alert.timer = ALERT_EVERY;
  const { player } = state;
  state.events.push({ type: 'sfx', name: 'pack', x: player.x, y: player.y });
  makeNoise(state, player.x, player.y, ALERT_NOISE, rt);
  state.noiseHeat += 1.5;
  if (state.time - state.alert.told > 45) {
    state.alert.told = state.time;
    state.events.push({ type: 'message', text: 'Sus gruñidos están atrayendo a los de alrededor', tone: 'danger' });
  }
}

/** ¿Qué campo de flujo lleva al punto (x, y)? El del jugador o el del último ruido, si alguno queda cerca. */
function fieldFor(rt: ZombieRuntime, state: GameState, x: number, y: number): FlowField | undefined {
  const toPlayer = Math.hypot(x - state.player.x, y - state.player.y);
  const toNoise = Math.hypot(x - state.lastNoise.x, y - state.lastNoise.y);
  if (toNoise < FIELD_SNAP && toNoise <= toPlayer) return rt.noiseField;
  if (toPlayer < FIELD_SNAP) return rt.field;
  return undefined;
}

/** Caché simple: la línea de visión al objetivo de investigación solo se recalcula al pensar. */
// Un caché por runtime (no uno global): si no, una partida nueva heredaba los valores de la
// anterior para los mismos ids y la misma seed no daba siempre la misma partida.
const losCaches = new WeakMap<ZombieRuntime, Map<number, boolean>>();
function lineOfSightCached(rt: ZombieRuntime, z: Zombie, x: number, y: number, tick: number): boolean {
  let losCache = losCaches.get(rt);
  if (!losCache) {
    losCache = new Map();
    losCaches.set(rt, losCache);
  }
  if ((tick + z.id) % THINK_EVERY === 0 || !losCache.has(z.id)) {
    losCache.set(z.id, lineOfSight(rt.city.grid, z.x, z.y, x, y));
    if (losCache.size > 2000) losCache.clear();
  }
  return losCache.get(z.id)!;
}

/**
 * El gritón te vio: chilla. Es un ruido enorme (todos los de alrededor vienen a mirar) y además
 * llama a una horda chica. Se queda quieto gritando un segundo: la ventana para callarlo.
 */
function scream(state: GameState, rt: ZombieRuntime, z: Zombie): void {
  z.ability = SCREAM_COOLDOWN;
  z.stagger = 1.1;
  state.events.push({ type: 'sfx', name: 'scream', x: z.x, y: z.y });
  state.events.push({ type: 'message', text: '¡Un gritón te vio y está llamando a los demás!', tone: 'danger' });
  makeNoise(state, z.x, z.y, SCREAM_NOISE, rt);
  // El grito apunta a donde estás TÚ (te está viendo), no a él.
  state.lastNoise = { x: state.player.x, y: state.player.y, time: state.time };
  rt.noiseField.update(state.player.x, state.player.y);
  state.noiseHeat += 4;
  spawnHorde(state, rt, SCREAM_HORDE);
}

/**
 * La embestida del tanque arrolla lo que encuentra: los zombies en su camino salen volando hacia
 * los costados (y se lastiman). Se usa la grilla espacial para no revisar a los 300.
 */
function trample(state: GameState, rt: ZombieRuntime, tank: Zombie, self: number): void {
  const fx = Math.cos(tank.facing);
  const fy = Math.sin(tank.facing);
  rt.hash.query(tank.x, tank.y, tank.radius + 1, (j) => {
    if (j === self) return;
    const o = state.zombies[j];
    if (!o || o.hp <= 0 || o.air > 0 || o.kind === 'tank') return;
    const dx = o.x - tank.x;
    const dy = o.y - tank.y;
    const d = Math.hypot(dx, dy);
    if (d > tank.radius + o.radius + 0.3) return;
    // Hacia qué costado sale: el lado del tanque en el que estaba (producto cruz).
    const side = fx * dy - fy * dx >= 0 ? 1 : -1;
    damageZombie(state, o, CHARGE_LAUNCH_DAMAGE, 0, 0, 0.5, {});
    launchZombie(o, fx * 9 - fy * side * 7, fy * 9 + fx * side * 7, 8);
  });
}

function startStun(z: Zombie, seconds: number): void {
  z.mode = 'stunned';
  z.timer = seconds;
}

export function hurtPlayer(state: GameState, damage: number): void {
  if (state.status !== 'playing') return;
  // Dash: un instante de invulnerabilidad para escapar de un encierro.
  if (state.player.invuln > 0) return;
  state.player.hp = Math.max(0, state.player.hp - damage);
  state.player.hurtTimer = 0;
  state.events.push({ type: 'hurt', damage });
}

/** Las hordas son sobre todo caminantes, con algún corredor y algún hinchado entre medio. */
function hordeKind(state: GameState): ZombieKind {
  const r = random(state);
  return r < 0.14 ? 'runner' : r < 0.2 ? 'bloater' : 'walker';
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
  state.noiseHeat = Math.max(0, state.noiseHeat - 0.25 * dt);

  const byNoise = state.noiseHeat >= HORDE_HEAT_LIMIT;
  if (state.hordeTimer > 0 && !byNoise) return;
  state.hordeTimer = HORDE_INTERVAL * (1 - 0.45 * danger);
  state.noiseHeat = 0;
  const size = Math.round(14 + 14 * danger);
  if (spawnHorde(state, rt, size)) {
    state.events.push({ type: 'sfx', name: 'horde', x: state.player.x, y: state.player.y });
    state.events.push({
      type: 'message',
      text: byNoise ? '¡El ruido atrajo una horda!' : '¡Se acerca una horda!',
      tone: 'danger',
    });
  }
}

/**
 * Crea una horda fuera de la vista del jugador, a una distancia (caminando) de 26 a 44 tiles.
 * La horda va hacia el último ruido fuerte; si hace rato que no haces ruido, hacia la zona donde
 * estás pero con mucho error: "algo los atrajo a este barrio", no "saben en qué esquina estás".
 */
export function spawnHorde(state: GameState, rt: ZombieRuntime, size: number): boolean {
  const { grid } = rt.city;
  const count = Math.min(size, MAX_ZOMBIES - state.zombies.length);
  if (count <= 0) return false;
  if (state.time - state.lastNoise.time > 20) {
    const x = state.player.x + randomRange(state, -10, 10);
    const y = state.player.y + randomRange(state, -10, 10);
    state.lastNoise = { x, y, time: state.time - 10 };
    rt.noiseField.update(x, y);
  }

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
      const z = createZombie(state, zx, zy, hordeKind(state));
      // Un movimiento nulo aplica la "depenetración": si quedó pegado a un muro, lo saca.
      const fixed = moveCircle(grid, zx, zy, z.radius, 0, 0);
      z.x = z.prevX = fixed.x;
      z.y = z.prevY = fixed.y;
      z.mode = 'investigate';
      z.timer = 9;
      z.targetX = state.lastNoise.x + randomRange(state, -3, 3);
      z.targetY = state.lastNoise.y + randomRange(state, -3, 3);
      z.hordeUntil = state.time + HORDE_CHASE_TIME;
      state.zombies.push(z);
      placed++;
    }
    state.stats.hordes++;
    return placed > 0;
  }
  return false;
}
