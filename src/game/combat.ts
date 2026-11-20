// Combate del jugador: arma cuerpo a cuerpo y pistola.
//
// Las dos armas tienen un rol distinto, y esa es la gracia:
//  - Cuerpo a cuerpo (bate): sin munición y casi silencioso, pero de corto alcance. Empuja y
//    aturde, sirve para abrirse paso entre unos pocos zombies.
//  - Pistola: mata a distancia, pero las balas son escasas y cada disparo HACE RUIDO: atrae a los
//    zombies cercanos y suma "calor" que puede llamar a una horda (ver zombies.ts).
//
// Los disparos son "hitscan": la bala llega al instante. Se calcula con un rayo:
//  1. ¿Hasta dónde llega antes de chocar con una pared? (castRay sobre la grilla)
//  2. ¿Qué zombie corta el rayo antes de esa distancia? (intersección rayo-círculo)

import { random } from './random';
import type { GameState } from './state';
import { blocksBullets, castRay } from './visibility';
import { damageZombie, makeNoise, type ZombieRuntime } from './zombies';

export type WeaponId = 'melee' | 'pistol';

export interface WeaponState {
  current: WeaponId;
  /** Balas en el cargador. */
  mag: number;
  /** Balas de reserva (lo que se encuentra como loot). */
  reserve: number;
  /** Segundos hasta poder atacar de nuevo. */
  cooldown: number;
  /** Segundos que faltan para terminar de recargar (0 = no está recargando). */
  reloadTimer: number;
}

export interface CombatIntent {
  /** Clic izquierdo: ataca con el arma actual. */
  attack: boolean;
  /** Clic derecho: golpe rápido cuerpo a cuerpo, con cualquier arma en la mano. */
  melee: boolean;
  reload: boolean;
  /** Cambiar de arma: una específica o alternar. */
  select?: WeaponId | 'swap';
}

export const PISTOL_MAG = 12;
const PISTOL_COOLDOWN = 0.22;
const PISTOL_RANGE = 32;
const PISTOL_DAMAGE = 60;
const PISTOL_SPREAD = 0.035;
const PISTOL_NOISE = 26;
const RELOAD_TIME = 1.4;

const MELEE_COOLDOWN = 0.5;
const MELEE_REACH = 1.75;
const MELEE_ARC = (120 * Math.PI) / 180;
const MELEE_DAMAGE = 55;
const MELEE_MAX_TARGETS = 3;
const MELEE_NOISE = 6;
/** Ejecución sigilosa: agachado y por sorpresa, el bate mata de un golpe y casi sin ruido. */
const TAKEDOWN_NOISE = 2;

export function createWeapons(): WeaponState {
  return { current: 'pistol', mag: PISTOL_MAG, reserve: 12, cooldown: 0, reloadTimer: 0 };
}

export function updateCombat(state: GameState, rt: ZombieRuntime, intent: CombatIntent, dt: number): void {
  const weapon = state.weapon;
  weapon.cooldown = Math.max(0, weapon.cooldown - dt);

  if (weapon.reloadTimer > 0) {
    weapon.reloadTimer -= dt;
    if (weapon.reloadTimer <= 0) {
      const taken = Math.min(PISTOL_MAG - weapon.mag, weapon.reserve);
      weapon.mag += taken;
      weapon.reserve -= taken;
      weapon.reloadTimer = 0;
    }
  }

  if (intent.select) {
    const next = intent.select === 'swap' ? (weapon.current === 'pistol' ? 'melee' : 'pistol') : intent.select;
    if (next !== weapon.current) {
      weapon.current = next;
      weapon.reloadTimer = 0; // cambiar de arma cancela la recarga
      weapon.cooldown = Math.max(weapon.cooldown, 0.25);
    }
  }

  if (intent.reload) startReload(state);

  if (weapon.cooldown > 0) return;
  if (intent.melee || (intent.attack && weapon.current === 'melee')) {
    swing(state, rt);
  } else if (intent.attack && weapon.current === 'pistol') {
    shoot(state, rt);
  }
}

function startReload(state: GameState): void {
  const weapon = state.weapon;
  if (weapon.current !== 'pistol' || weapon.reloadTimer > 0 || weapon.mag >= PISTOL_MAG) return;
  if (weapon.reserve <= 0) {
    state.events.push({ type: 'message', text: 'No quedan balas de reserva' });
    return;
  }
  weapon.reloadTimer = RELOAD_TIME;
  state.events.push({ type: 'sfx', name: 'reload', x: state.player.x, y: state.player.y });
}

function shoot(state: GameState, rt: ZombieRuntime): void {
  const weapon = state.weapon;
  if (weapon.reloadTimer > 0) return;
  if (weapon.mag <= 0) {
    // Gatillo en vacío: recarga sola si hay reserva.
    if (weapon.reserve > 0) startReload(state);
    else state.events.push({ type: 'message', text: '*clic* Sin balas: cambia al bate [Q]' });
    state.events.push({ type: 'sfx', name: 'empty', x: state.player.x, y: state.player.y });
    weapon.cooldown = 0.3;
    return;
  }

  weapon.mag--;
  weapon.cooldown = PISTOL_COOLDOWN;
  state.stats.shots++;

  const { player } = state;
  const angle = player.facing + (random(state) * 2 - 1) * PISTOL_SPREAD;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  // La bala sale desde un poco adelante del cuerpo.
  const ox = player.x + dirX * 0.45;
  const oy = player.y + dirY * 0.45;
  let hitDist = castRay(rt.city.grid, ox, oy, dirX, dirY, PISTOL_RANGE, blocksBullets);

  // Intersección rayo-círculo: proyectamos el centro del zombie sobre el rayo (t), y si la
  // distancia perpendicular es menor que su radio, el rayo lo corta. Gana el más cercano.
  let target = -1;
  for (let i = 0; i < state.zombies.length; i++) {
    const z = state.zombies[i];
    if (z.hp <= 0) continue;
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

  if (target >= 0) damageZombie(state, state.zombies[target], PISTOL_DAMAGE, dirX * 4, dirY * 4, 0.25);
  state.events.push({ type: 'shot', fromX: ox, fromY: oy, toX: ox + dirX * hitDist, toY: oy + dirY * hitDist });

  makeNoise(state, player.x, player.y, PISTOL_NOISE);
  state.noiseHeat += 1;
}

function swing(state: GameState, rt: ZombieRuntime): void {
  const { player } = state;
  state.weapon.cooldown = MELEE_COOLDOWN;
  state.events.push({ type: 'swing', x: player.x, y: player.y, facing: player.facing });

  // Los más cercanos primero, hasta 3 por golpe, dentro de un arco frente al jugador.
  const candidates: { index: number; dist: number }[] = [];
  rt.hash.query(player.x, player.y, MELEE_REACH + 1, (i) => {
    const z = state.zombies[i];
    if (!z || z.hp <= 0) return;
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
    if (player.sneaking && unaware && z.kind === 'walker') {
      damageZombie(state, z, z.hp, nx * 2, ny * 2, 0);
      state.events.push({ type: 'sfx', name: 'takedown', x: z.x, y: z.y });
    } else {
      damageZombie(state, z, MELEE_DAMAGE, nx * 7, ny * 7, 0.55);
      loud = true;
    }
  }
  makeNoise(state, player.x, player.y, loud ? MELEE_NOISE : TAKEDOWN_NOISE);
}
