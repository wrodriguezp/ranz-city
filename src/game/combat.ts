// Combate del jugador: bate, pistola, escopeta, subfusil y granadas.
//
// Cada arma tiene un rol distinto, y esa es la gracia:
//  - Bate: sin munición y casi silencioso, pero de corto alcance. Empuja, aturde y a veces revienta.
//  - Pistola: precisa y con buen alcance. Las balas livianas son las más comunes.
//  - Escopeta: 9 perdigones en abanico; de cerca despeja una fila entera y los manda a volar.
//    De lejos los perdigones se abren y pierden fuerza. Mucho ruido, cartuchos escasos.
//  - Subfusil: automático (mantener clic). Derrite grupos, pero vacía el cargador en 2 segundos
//    y comparte balas con la pistola: es una decisión gastarlas así.
//  - Granadas (G): ver explosives.ts.
// Todas las armas de fuego HACEN RUIDO: atraen zombies al lugar del disparo y suman "calor".
//
// Los disparos son "hitscan": la bala llega al instante. Se calcula con un rayo:
//  1. ¿Hasta dónde llega antes de chocar con una pared? (traceRay sobre la grilla; si choca con
//     un barril, el barril explota)
//  2. ¿Qué zombie corta el rayo antes de esa distancia? (intersección rayo-círculo)
// La escopeta es lo mismo, nueve veces con ángulos un poco distintos.

import { Tile } from '../world/tileGrid';
import { blowBarrel, throwGrenade } from './explosives';
import { spendStamina } from './player';
import { random } from './random';
import type { GameState } from './state';
import { blocksBullets, traceRay } from './visibility';
import { damageZombie, makeNoise, type ZombieRuntime } from './zombies';

export type WeaponId = 'melee' | 'pistol' | 'shotgun' | 'smg';
export type GunId = Exclude<WeaponId, 'melee'>;
/** light: balas livianas (pistola y subfusil). shells: cartuchos de escopeta. */
export type AmmoType = 'light' | 'shells';

interface GunSpec {
  name: string;
  ammo: AmmoType;
  mag: number;
  /** Segundos entre disparos. */
  cooldown: number;
  damage: number;
  pellets: number;
  /** Desvío máximo de cada bala, en radianes. */
  spread: number;
  range: number;
  noise: number;
  reload: number;
  /** Empujón por impacto (tiles/s). */
  knock: number;
  /** Automática: dispara mientras se mantiene el clic. */
  auto: boolean;
}

export const GUNS: Record<GunId, GunSpec> = {
  pistol: { name: 'PISTOLA', ammo: 'light', mag: 12, cooldown: 0.22, damage: 60, pellets: 1, spread: 0.035, range: 32, noise: 26, reload: 1.4, knock: 6, auto: false },
  shotgun: { name: 'ESCOPETA', ammo: 'shells', mag: 6, cooldown: 0.8, damage: 30, pellets: 9, spread: 0.2, range: 15, noise: 34, reload: 2.2, knock: 6, auto: false },
  smg: { name: 'SUBFUSIL', ammo: 'light', mag: 30, cooldown: 0.075, damage: 30, pellets: 1, spread: 0.09, range: 26, noise: 30, reload: 1.9, knock: 2.5, auto: true },
};
export const WEAPON_ORDER: WeaponId[] = ['melee', 'pistol', 'shotgun', 'smg'];

export interface WeaponState {
  current: WeaponId;
  owned: Record<WeaponId, boolean>;
  /** Balas en el cargador de cada arma. */
  mags: Record<GunId, number>;
  /** Munición de reserva por tipo (lo que se encuentra como loot). */
  ammo: Record<AmmoType, number>;
  /** Segundos hasta poder atacar de nuevo. */
  cooldown: number;
  /** Segundos que faltan para terminar de recargar (0 = no está recargando). */
  reloadTimer: number;
}

export interface CombatIntent {
  /** Clic izquierdo recién apretado: ataca con el arma actual. */
  attack: boolean;
  /** Clic izquierdo mantenido (para las automáticas). */
  attackHeld: boolean;
  /** Clic derecho: golpe rápido cuerpo a cuerpo, con cualquier arma en la mano. */
  melee: boolean;
  reload: boolean;
  /** Cambiar de arma: una específica o la siguiente que tengas. */
  select?: WeaponId | 'next';
  /** G: lanzar una granada hacia el mouse. */
  throwGrenade: boolean;
  aimX: number;
  aimY: number;
}

const MELEE_COOLDOWN = 0.5;
const MELEE_REACH = 1.75;
const MELEE_ARC = (120 * Math.PI) / 180;
const MELEE_DAMAGE = 60;
/** Probabilidad de golpe crítico con el bate: mata de una y revienta al zombie. */
const MELEE_CRIT_CHANCE = 0.22;
const MELEE_MAX_TARGETS = 3;
const MELEE_NOISE = 6;
/** Cada golpe gasta estamina. Cansado, el bate pega más lento y más débil. */
const MELEE_STAMINA = 9;
const TIRED_COOLDOWN = 0.85;
const TIRED_DAMAGE = 0.6;
/** Ejecución sigilosa: agachado y por sorpresa, el bate mata de un golpe y casi sin ruido. */
const TAKEDOWN_NOISE = 2;
/** La escopeta revienta a los que están a menos de esto. */
const SHOTGUN_GIB_RANGE = 4.5;

export function createWeapons(): WeaponState {
  return {
    current: 'pistol',
    owned: { melee: true, pistol: true, shotgun: false, smg: false },
    mags: { pistol: GUNS.pistol.mag, shotgun: 0, smg: 0 },
    ammo: { light: 24, shells: 0 },
    cooldown: 0,
    reloadTimer: 0,
  };
}

export function isGun(id: WeaponId): id is GunId {
  return id !== 'melee';
}

export function updateCombat(state: GameState, rt: ZombieRuntime, intent: CombatIntent, dt: number): void {
  const weapon = state.weapon;
  weapon.cooldown = Math.max(0, weapon.cooldown - dt);

  if (weapon.reloadTimer > 0 && isGun(weapon.current)) {
    weapon.reloadTimer -= dt;
    if (weapon.reloadTimer <= 0) {
      const gun = GUNS[weapon.current];
      const taken = Math.min(gun.mag - weapon.mags[weapon.current], weapon.ammo[gun.ammo]);
      weapon.mags[weapon.current] += taken;
      weapon.ammo[gun.ammo] -= taken;
      weapon.reloadTimer = 0;
    }
  }

  if (intent.select) selectWeapon(state, intent.select);
  if (intent.reload) startReload(state);
  if (intent.throwGrenade) throwGrenade(state, intent.aimX, intent.aimY);

  if (weapon.cooldown > 0) return;
  const current = weapon.current;
  if (intent.melee || (intent.attack && current === 'melee')) {
    swing(state, rt);
  } else if (isGun(current) && (intent.attack || (intent.attackHeld && GUNS[current].auto))) {
    shoot(state, rt, current);
  }
}

function selectWeapon(state: GameState, select: WeaponId | 'next'): void {
  const weapon = state.weapon;
  let next: WeaponId = weapon.current;
  if (select === 'next') {
    // La siguiente arma que tengas, en orden, dando la vuelta.
    const start = WEAPON_ORDER.indexOf(weapon.current);
    for (let i = 1; i <= WEAPON_ORDER.length; i++) {
      const candidate = WEAPON_ORDER[(start + i) % WEAPON_ORDER.length];
      if (weapon.owned[candidate]) {
        next = candidate;
        break;
      }
    }
  } else if (weapon.owned[select]) {
    next = select;
  } else {
    state.events.push({ type: 'message', text: 'Todavía no tienes esa arma' });
  }
  if (next === weapon.current) return;
  weapon.current = next;
  weapon.reloadTimer = 0; // cambiar de arma cancela la recarga
  weapon.cooldown = Math.max(weapon.cooldown, 0.25);
  state.events.push({ type: 'sfx', name: 'switch', x: state.player.x, y: state.player.y });
}

function startReload(state: GameState): void {
  const weapon = state.weapon;
  if (!isGun(weapon.current) || weapon.reloadTimer > 0) return;
  const gun = GUNS[weapon.current];
  if (weapon.mags[weapon.current] >= gun.mag) return;
  if (weapon.ammo[gun.ammo] <= 0) {
    state.events.push({ type: 'message', text: gun.ammo === 'shells' ? 'No quedan cartuchos' : 'No quedan balas de reserva' });
    return;
  }
  weapon.reloadTimer = gun.reload;
  state.events.push({ type: 'sfx', name: 'reload', x: state.player.x, y: state.player.y });
}

function shoot(state: GameState, rt: ZombieRuntime, id: GunId): void {
  const weapon = state.weapon;
  const gun = GUNS[id];
  if (weapon.reloadTimer > 0) return;
  if (weapon.mags[id] <= 0) {
    // Gatillo en vacío: recarga sola si hay reserva.
    if (weapon.ammo[gun.ammo] > 0) startReload(state);
    else state.events.push({ type: 'message', text: '*clic* Sin munición: cambia de arma [Q] o usa el bate [1]' });
    state.events.push({ type: 'sfx', name: 'empty', x: state.player.x, y: state.player.y });
    weapon.cooldown = 0.3;
    return;
  }

  weapon.mags[id]--;
  weapon.cooldown = gun.cooldown;
  state.stats.shots++;

  const { player } = state;
  for (let p = 0; p < gun.pellets; p++) {
    const angle = player.facing + (random(state) * 2 - 1) * gun.spread;
    fireRay(state, rt, id, angle, p === 0);
  }

  makeNoise(state, player.x, player.y, gun.noise, rt);
  state.noiseHeat += id === 'smg' ? 0.5 : id === 'shotgun' ? 1.5 : 1;
}

/** Una bala (o un perdigón): rayo contra la grilla, después contra los zombies. */
function fireRay(state: GameState, rt: ZombieRuntime, id: GunId, angle: number, first: boolean): void {
  const gun = GUNS[id];
  const { player } = state;
  const grid = rt.city.grid;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  // La bala sale desde un poco adelante del cuerpo.
  const ox = player.x + dirX * 0.45;
  const oy = player.y + dirY * 0.45;
  let barrelTile = -1;
  let hitDist = traceRay(grid, ox, oy, dirX, dirY, gun.range, (tx, ty, tile) => {
    if (tile === Tile.Barrel) barrelTile = ty * grid.width + tx;
    return blocksBullets(tile);
  });

  // Intersección rayo-círculo: proyectamos el centro del zombie sobre el rayo (t), y si la
  // distancia perpendicular es menor que su radio, el rayo lo corta. Gana el más cercano.
  let target = -1;
  for (let i = 0; i < state.zombies.length; i++) {
    const z = state.zombies[i];
    if (z.hp <= 0 || z.air > 1.2) continue; // el que va volando por encima, se salva
    const zx = z.x - ox;
    const zy = z.y - oy;
    const t = zx * dirX + zy * dirY;
    if (t < 0 || t - z.radius > hitDist) continue;
    const perp2 = zx * zx + zy * zy - t * t;
    if (perp2 > z.radius * z.radius) continue;
    const entry = t - Math.sqrt(z.radius * z.radius - perp2);
    if (entry < hitDist) {
      hitDist = Math.max(0, entry);
      target = i;
    }
  }

  if (target >= 0) {
    const z = state.zombies[target];
    // Los perdigones pierden fuerza con la distancia; de muy cerca, la escopeta revienta.
    const falloff = id === 'shotgun' ? Math.max(0.35, 1 - hitDist / gun.range) : 1;
    damageZombie(state, z, gun.damage * falloff, dirX * gun.knock, dirY * gun.knock, id === 'shotgun' ? 0.45 : 0.3, {
      gib: id === 'shotgun' && hitDist < SHOTGUN_GIB_RANGE,
    });
  } else if (barrelTile >= 0) {
    const barrel = rt.city.barrels.find((b) => b.y * grid.width + b.x === barrelTile);
    if (barrel) blowBarrel(state, rt, barrel.id);
  }
  const hit = target >= 0 ? 'zombie' : hitDist < gun.range ? 'wall' : 'none';
  state.events.push({
    type: 'shot',
    fromX: ox,
    fromY: oy,
    toX: ox + dirX * hitDist,
    toY: oy + dirY * hitDist,
    hit,
    weapon: id,
    first,
  });
}

function swing(state: GameState, rt: ZombieRuntime): void {
  const { player } = state;
  const rested = spendStamina(player, MELEE_STAMINA);
  state.weapon.cooldown = rested ? MELEE_COOLDOWN : TIRED_COOLDOWN;
  const power = rested ? 1 : TIRED_DAMAGE;
  state.events.push({ type: 'swing', x: player.x, y: player.y, facing: player.facing });
  if (!rested) state.events.push({ type: 'sfx', name: 'tired', x: player.x, y: player.y });

  // Los más cercanos primero, hasta 3 por golpe, dentro de un arco frente al jugador.
  const candidates: { index: number; dist: number }[] = [];
  rt.hash.query(player.x, player.y, MELEE_REACH + 1, (i) => {
    const z = state.zombies[i];
    if (!z || z.hp <= 0 || z.air > 1) return;
    const dx = z.x - player.x;
    const dy = z.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist - z.radius > MELEE_REACH) return;
    let diff = Math.atan2(dy, dx) - player.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > MELEE_ARC / 2 && dist > z.radius + 0.5) return;
    candidates.push({ index: i, dist });
  });
  candidates.sort((a, b) => a.dist - b.dist);
  let loud = candidates.length === 0;
  for (const { index, dist } of candidates.slice(0, MELEE_MAX_TARGETS)) {
    const z = state.zombies[index];
    const nx = (z.x - player.x) / (dist || 1);
    const ny = (z.y - player.y) / (dist || 1);
    // Un zombie común que todavía no te persigue, golpeado agachado: ejecución de un golpe.
    const unaware = z.mode !== 'chase' && z.mode !== 'charge';
    if (player.sneaking && unaware && z.kind !== 'tank') {
      damageZombie(state, z, z.hp, nx * 2, ny * 2, 0);
      state.events.push({ type: 'sfx', name: 'takedown', x: z.x, y: z.y });
    } else {
      // Crítico: el golpe puede reventar al zombie (nunca al tanque).
      const crit = z.kind !== 'tank' && random(state) < MELEE_CRIT_CHANCE;
      damageZombie(state, z, (crit ? MELEE_DAMAGE * 3 : MELEE_DAMAGE) * power, nx * 10 * power, ny * 10 * power, 0.6 * power, { crit, gib: crit });
      loud = true;
    }
  }
  makeNoise(state, player.x, player.y, loud ? MELEE_NOISE : TAKEDOWN_NOISE);
}
