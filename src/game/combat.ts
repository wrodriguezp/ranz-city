// Combate del jugador: armas cuerpo a cuerpo, de fuego, especiales y lanzables.
//
// Cada arma tiene un rol distinto, y esa es la gracia:
//  - Cuerpo a cuerpo (ver MELEES): sin munición y casi silenciosas. El bate nunca se rompe; el
//    machete, el hacha, la maza y la katana pegan más (y cortan miembros) pero se gastan con cada
//    golpe que conecta. Al romperse vuelves al bate. Recoger una nueva reemplaza la que tienes.
//  - Pistola: precisa y con buen alcance. Las balas livianas son las más comunes.
//  - Escopeta: 9 perdigones en abanico; de cerca despeja una fila entera y los manda a volar.
//  - Subfusil: automático (mantener clic). Comparte balas con la pistola.
//  - Especiales (tecla 5, raras): minigun, lanzallamas y lanzacohetes. Traen su munición y no se
//    recargan: cuando se vacían se sueltan. Son un "momento", no un arma para toda la partida.
//  - Lanzables (G, T cambia): ver explosives.ts.
// Todas las armas de fuego HACEN RUIDO: atraen zombies al lugar del disparo y suman "calor".
//
// Los disparos son "hitscan": la bala llega al instante. Se calcula con un rayo:
//  1. ¿Hasta dónde llega antes de chocar con una pared? (traceRay sobre la grilla; si choca con
//     un barril, el barril explota; si choca con un auto con alarma, la alarma salta)
//  2. ¿Qué zombie corta el rayo antes de esa distancia? (intersección rayo-círculo)
// La escopeta es lo mismo, nueve veces con ángulos un poco distintos.

import { Tile } from '../world/tileGrid';
import { blowBarrel, cycleThrowable, fireRocket, throwSelected } from './explosives';
import { addHazard } from './hazards';
import { triggerCarAlarm } from './loot';
import { spendStamina } from './player';
import { random } from './random';
import type { GameState } from './state';
import { blocksBullets, traceRay } from './visibility';
import { damageZombie, makeNoise, type ZombieRuntime } from './zombies';

export type SpecialId = 'minigun' | 'flamer' | 'rocket';
export type WeaponId = 'melee' | 'pistol' | 'shotgun' | 'smg' | SpecialId;
export type GunId = Exclude<WeaponId, 'melee'>;
/** light: balas livianas (pistola y subfusil). shells: cartuchos de escopeta. */
export type AmmoType = 'light' | 'shells';
export type MeleeId = 'bat' | 'machete' | 'axe' | 'sledge' | 'katana';

interface GunSpec {
  name: string;
  /** null: arma especial, sin reserva (solo lo que trae el cargador). */
  ammo: AmmoType | null;
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
  // La minigun no se recarga: 180 balas a 22 por segundo, y te frena mientras disparas.
  minigun: { name: 'MINIGUN', ammo: null, mag: 180, cooldown: 0.045, damage: 32, pellets: 1, spread: 0.11, range: 30, noise: 44, reload: 0, knock: 3.5, auto: true },
  // Lanzallamas: corto alcance, no es un rayo sino un cono; prende fuego a lo que toca.
  flamer: { name: 'LANZALLAMAS', ammo: null, mag: 160, cooldown: 0.05, damage: 4, pellets: 0, spread: 0.32, range: 7, noise: 14, reload: 0, knock: 0.6, auto: true },
  // Lanzacohetes: un proyectil que explota al tocar algo (ver explosives.ts).
  rocket: { name: 'LANZACOHETES', ammo: null, mag: 4, cooldown: 1.1, damage: 0, pellets: 0, spread: 0, range: 40, noise: 30, reload: 0, knock: 0, auto: false },
};
export const SPECIALS: SpecialId[] = ['minigun', 'flamer', 'rocket'];
/** Orden al pasar de arma con Q. En el HUD las especiales comparten el lugar 5. */
export const WEAPON_ORDER: WeaponId[] = ['melee', 'pistol', 'shotgun', 'smg', 'minigun', 'flamer', 'rocket'];

interface MeleeSpec {
  name: string;
  damage: number;
  cooldown: number;
  reach: number;
  /** Ancho del arco frente al jugador, en radianes. */
  arc: number;
  targets: number;
  stamina: number;
  /** Probabilidad de crítico (mata de una y revienta, o decapita si el arma corta). */
  crit: number;
  /** Probabilidad de cortar un miembro en cada golpe (ver damageZombie). */
  sever: number;
  knock: number;
  /** Golpes que aguanta (-1 = nunca se rompe). */
  durability: number;
}

const deg = (d: number) => (d * Math.PI) / 180;
export const MELEES: Record<MeleeId, MeleeSpec> = {
  // El bate: confiable y eterno. Empuja y aturde.
  bat: { name: 'BATE', damage: 60, cooldown: 0.5, reach: 1.75, arc: deg(120), targets: 3, stamina: 9, crit: 0.22, sever: 0, knock: 10, durability: -1 },
  // Machete: rápido y gasta poco aire; corta brazos.
  machete: { name: 'MACHETE', damage: 75, cooldown: 0.38, reach: 1.8, arc: deg(110), targets: 2, stamina: 7, crit: 0.1, sever: 0.45, knock: 6, durability: 60 },
  // Hacha: lenta, pega fuerte, corta.
  axe: { name: 'HACHA', damage: 110, cooldown: 0.65, reach: 1.85, arc: deg(100), targets: 2, stamina: 12, crit: 0.15, sever: 0.35, knock: 9, durability: 40 },
  // Maza: muy lenta y cansadora, pero barre un arco enorme y manda a volar a una fila entera.
  sledge: { name: 'MAZA', damage: 140, cooldown: 0.95, reach: 2.0, arc: deg(160), targets: 5, stamina: 20, crit: 0.3, sever: 0, knock: 18, durability: 35 },
  // Katana: rápida, de buen alcance y la que más corta. La más rara.
  katana: { name: 'KATANA', damage: 95, cooldown: 0.35, reach: 2.1, arc: deg(120), targets: 3, stamina: 8, crit: 0.12, sever: 0.6, knock: 5, durability: 50 },
};

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
  /** El arma cuerpo a cuerpo que llevas, y cuántos golpes le quedan (-1 = irrompible). */
  melee: MeleeId;
  durability: number;
  /** Disparos del lanzallamas (para dejar fuego en el suelo cada tanto). */
  flameCount: number;
}

export interface CombatIntent {
  /** Clic izquierdo recién apretado: ataca con el arma actual. */
  attack: boolean;
  /** Clic izquierdo mantenido (para las automáticas). */
  attackHeld: boolean;
  /** Clic derecho: golpe rápido cuerpo a cuerpo, con cualquier arma en la mano. */
  melee: boolean;
  reload: boolean;
  /** Cambiar de arma: una específica, la especial que tengas, o la siguiente. */
  select?: WeaponId | 'special' | 'next';
  /** G: lanzar el lanzable elegido hacia el mouse. */
  throwGrenade: boolean;
  /** T: elegir el siguiente lanzable. */
  cycleThrowable?: boolean;
  aimX: number;
  aimY: number;
}

/** Un zombie pegado al jugador cuenta aunque quede apenas fuera del arco. */
const MELEE_ARC_SLACK = 0.5;
const MELEE_NOISE = 6;
/** Cansado, el golpe sale más lento y más débil. */
const TIRED_COOLDOWN = 0.85;
const TIRED_DAMAGE = 0.6;
/** Ejecución sigilosa: agachado y por sorpresa, mata de un golpe y casi sin ruido. */
const TAKEDOWN_NOISE = 2;
/** La escopeta revienta a los que están a menos de esto, y de cerca puede arrancar un brazo. */
const SHOTGUN_GIB_RANGE = 4.5;
const SHOTGUN_SEVER = 0.12;
/** El lanzallamas deja fuego en el suelo cada tantos disparos. */
const FLAME_PUDDLE_EVERY = 8;

export function createWeapons(): WeaponState {
  return {
    current: 'pistol',
    owned: { melee: true, pistol: true, shotgun: false, smg: false, minigun: false, flamer: false, rocket: false },
    mags: { pistol: GUNS.pistol.mag, shotgun: 0, smg: 0, minigun: 0, flamer: 0, rocket: 0 },
    ammo: { light: 24, shells: 0 },
    cooldown: 0,
    reloadTimer: 0,
    melee: 'bat',
    durability: -1,
    flameCount: 0,
  };
}

export function isGun(id: WeaponId): id is GunId {
  return id !== 'melee';
}

export function isSpecial(id: WeaponId): id is SpecialId {
  return id === 'minigun' || id === 'flamer' || id === 'rocket';
}

/** La especial que tienes (solo se lleva una a la vez), o null. */
export function ownedSpecial(weapon: WeaponState): SpecialId | null {
  return SPECIALS.find((s) => weapon.owned[s]) ?? null;
}

export function updateCombat(state: GameState, rt: ZombieRuntime, intent: CombatIntent, dt: number): void {
  const weapon = state.weapon;
  weapon.cooldown = Math.max(0, weapon.cooldown - dt);

  if (weapon.reloadTimer > 0 && isGun(weapon.current)) {
    weapon.reloadTimer -= dt;
    const gun = GUNS[weapon.current];
    if (weapon.reloadTimer <= 0 && gun.ammo) {
      const taken = Math.min(gun.mag - weapon.mags[weapon.current], weapon.ammo[gun.ammo]);
      weapon.mags[weapon.current] += taken;
      weapon.ammo[gun.ammo] -= taken;
      weapon.reloadTimer = 0;
    }
  }

  if (intent.select) selectWeapon(state, intent.select);
  if (intent.reload) startReload(state);
  if (intent.cycleThrowable) cycleThrowable(state);
  if (intent.throwGrenade) throwSelected(state, intent.aimX, intent.aimY);

  if (weapon.cooldown > 0) return;
  const current = weapon.current;
  if (intent.melee || (intent.attack && current === 'melee')) {
    swing(state, rt);
  } else if (isGun(current) && (intent.attack || (intent.attackHeld && GUNS[current].auto))) {
    shoot(state, rt, current);
  }
}

function selectWeapon(state: GameState, select: WeaponId | 'special' | 'next'): void {
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
  } else if (select === 'special') {
    const special = ownedSpecial(weapon);
    if (special) next = special;
    else state.events.push({ type: 'message', text: 'No tienes un arma especial (pide un suministro con una bengala)' });
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
  if (!gun.ammo) return; // las especiales no se recargan
  if (weapon.mags[weapon.current] >= gun.mag) return;
  if (weapon.ammo[gun.ammo] <= 0) {
    state.events.push({ type: 'message', text: gun.ammo === 'shells' ? 'No quedan cartuchos' : 'No quedan balas de reserva' });
    return;
  }
  weapon.reloadTimer = gun.reload;
  state.events.push({ type: 'sfx', name: 'reload', x: state.player.x, y: state.player.y });
}

/** La mejor arma a la que volver cuando se suelta una especial: la que tenga balas. */
function fallbackWeapon(state: GameState): WeaponId {
  const w = state.weapon;
  for (const id of ['smg', 'shotgun', 'pistol'] as const) {
    const ammo = GUNS[id].ammo;
    if (w.owned[id] && (w.mags[id] > 0 || (ammo !== null && w.ammo[ammo] > 0))) return id;
  }
  return 'melee';
}

function shoot(state: GameState, rt: ZombieRuntime, id: GunId): void {
  const weapon = state.weapon;
  const gun = GUNS[id];
  if (weapon.reloadTimer > 0) return;
  if (weapon.mags[id] <= 0) {
    // Gatillo en vacío: recarga sola si hay reserva.
    if (gun.ammo && weapon.ammo[gun.ammo] > 0) startReload(state);
    else state.events.push({ type: 'message', text: '*clic* Sin munición: cambia de arma [Q] o usa el cuerpo a cuerpo [1]' });
    state.events.push({ type: 'sfx', name: 'empty', x: state.player.x, y: state.player.y });
    weapon.cooldown = 0.3;
    return;
  }

  weapon.mags[id]--;
  weapon.cooldown = gun.cooldown;
  state.stats.shots++;
  const { player } = state;

  if (id === 'flamer') {
    flame(state, rt);
  } else if (id === 'rocket') {
    fireRocket(state, player.facing);
  } else {
    for (let p = 0; p < gun.pellets; p++) {
      const angle = player.facing + (random(state) * 2 - 1) * gun.spread;
      fireRay(state, rt, id, angle, p === 0);
    }
  }

  makeNoise(state, player.x, player.y, gun.noise, rt);
  state.noiseHeat += id === 'smg' || id === 'minigun' ? 0.5 : id === 'shotgun' || id === 'rocket' ? 1.5 : id === 'flamer' ? 0.1 : 1;

  // Una especial vacía se tira: no hay de dónde recargarla.
  if (isSpecial(id) && weapon.mags[id] <= 0) {
    weapon.owned[id] = false;
    weapon.current = fallbackWeapon(state);
    weapon.cooldown = 0.5;
    state.events.push({ type: 'drop', what: gun.name });
    state.events.push({ type: 'message', text: `${gun.name} vacía: la sueltas` });
  }
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
  let carTile = -1;
  let hitDist = traceRay(grid, ox, oy, dirX, dirY, gun.range, (tx, ty, tile) => {
    if (tile === Tile.Barrel) barrelTile = ty * grid.width + tx;
    if (tile === Tile.Car) carTile = ty * grid.width + tx;
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
    const shotgun = id === 'shotgun';
    const close = shotgun && hitDist < SHOTGUN_GIB_RANGE;
    const falloff = shotgun ? Math.max(0.35, 1 - hitDist / gun.range) : 1;
    damageZombie(state, z, gun.damage * falloff, dirX * gun.knock, dirY * gun.knock, shotgun ? 0.45 : 0.3, {
      gib: close,
      sever: close ? SHOTGUN_SEVER : 0,
    });
  } else if (barrelTile >= 0) {
    const barrel = rt.city.barrels.find((b) => b.y * grid.width + b.x === barrelTile);
    if (barrel) blowBarrel(state, rt, barrel.id);
  } else if (carTile >= 0) {
    triggerCarAlarm(state, rt, carTile % grid.width, Math.floor(carTile / grid.width));
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

/**
 * Lanzallamas: un cono corto. No es un rayo por zombie sino "todos los que estén dentro del cono
 * y antes de la primera pared". Daña poco por disparo, pero dispara 20 veces por segundo y deja
 * a todos ARDIENDO (ver hazards.ts), que es lo que de verdad los mata.
 */
function flame(state: GameState, rt: ZombieRuntime): void {
  const { player } = state;
  const gun = GUNS.flamer;
  const dirX = Math.cos(player.facing);
  const dirY = Math.sin(player.facing);
  const ox = player.x + dirX * 0.5;
  const oy = player.y + dirY * 0.5;
  const reach = traceRay(rt.city.grid, ox, oy, dirX, dirY, gun.range, (_x, _y, tile) => blocksBullets(tile));
  const slope = Math.tan(gun.spread);
  rt.hash.query(ox + dirX * reach * 0.5, oy + dirY * reach * 0.5, reach * 0.5 + 2, (i) => {
    const z = state.zombies[i];
    if (!z || z.hp <= 0) return;
    const zx = z.x - ox;
    const zy = z.y - oy;
    const along = zx * dirX + zy * dirY;
    if (along < -0.3 || along > reach + z.radius) return;
    // Un cono que se abre: más ancho al fondo.
    const across = Math.abs(zx * dirY - zy * dirX);
    if (across > 0.4 + Math.max(0, along) * slope + z.radius) return;
    z.burn = Math.max(z.burn, 4);
    damageZombie(state, z, gun.damage, dirX * gun.knock, dirY * gun.knock, 0, { quiet: true });
  });
  const weapon = state.weapon;
  weapon.flameCount++;
  if (weapon.flameCount % FLAME_PUDDLE_EVERY === 0) {
    const d = Math.max(0.5, reach - 0.6);
    addHazard(state, 'fire', ox + dirX * d, oy + dirY * d, 1.2, 3);
  }
  state.events.push({ type: 'flame', x: ox, y: oy, toX: ox + dirX * reach, toY: oy + dirY * reach });
}

function swing(state: GameState, rt: ZombieRuntime): void {
  const { player, weapon } = state;
  const spec = MELEES[weapon.melee];
  const rested = spendStamina(player, spec.stamina);
  weapon.cooldown = rested ? spec.cooldown : Math.max(spec.cooldown, TIRED_COOLDOWN);
  const power = rested ? 1 : TIRED_DAMAGE;
  state.events.push({ type: 'swing', x: player.x, y: player.y, facing: player.facing });
  if (!rested) state.events.push({ type: 'sfx', name: 'tired', x: player.x, y: player.y });

  // Los más cercanos primero, hasta `targets` por golpe, dentro de un arco frente al jugador.
  const candidates: { index: number; dist: number }[] = [];
  rt.hash.query(player.x, player.y, spec.reach + 1, (i) => {
    const z = state.zombies[i];
    if (!z || z.hp <= 0 || z.air > 1) return;
    const dx = z.x - player.x;
    const dy = z.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist - z.radius > spec.reach) return;
    let diff = Math.atan2(dy, dx) - player.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > spec.arc / 2 && dist > z.radius + MELEE_ARC_SLACK) return;
    candidates.push({ index: i, dist });
  });
  candidates.sort((a, b) => a.dist - b.dist);
  let loud = candidates.length === 0;
  for (const { index, dist } of candidates.slice(0, spec.targets)) {
    const z = state.zombies[index];
    const nx = (z.x - player.x) / (dist || 1);
    const ny = (z.y - player.y) / (dist || 1);
    // Un zombie común que todavía no te persigue, golpeado agachado: ejecución de un golpe.
    // Con un arma que corta, la ejecución es una decapitación.
    const unaware = z.mode !== 'chase' && z.mode !== 'charge';
    if (player.sneaking && unaware && z.kind !== 'tank') {
      damageZombie(state, z, z.hp, nx * 2, ny * 2, 0, { behead: spec.sever > 0 });
      state.events.push({ type: 'sfx', name: 'takedown', x: z.x, y: z.y });
    } else {
      // Crítico: el golpe puede reventar al zombie (nunca al tanque); con filo, lo decapita.
      const crit = z.kind !== 'tank' && random(state) < spec.crit;
      const k = spec.knock * power;
      damageZombie(state, z, (crit ? spec.damage * 3 : spec.damage) * power, nx * k, ny * k, 0.6 * power, {
        crit,
        gib: crit && spec.sever === 0,
        behead: crit && spec.sever > 0,
        sever: spec.sever * power,
      });
      loud = true;
    }
  }

  // Golpear un auto con alarma también la hace saltar.
  if (candidates.length === 0) {
    const tx = Math.floor(player.x + Math.cos(player.facing) * 1.1);
    const ty = Math.floor(player.y + Math.sin(player.facing) * 1.1);
    const grid = rt.city.grid;
    if (tx >= 0 && ty >= 0 && tx < grid.width && ty < grid.height && grid.tiles[ty * grid.width + tx] === Tile.Car) {
      triggerCarAlarm(state, rt, tx, ty);
    }
  }

  // Desgaste: cada golpe que conecta le quita un punto al arma (al bate no).
  if (candidates.length > 0 && weapon.durability > 0) {
    weapon.durability--;
    if (weapon.durability === 0) {
      state.events.push({ type: 'message', text: `Se rompió: ${spec.name}. Vuelves al bate`, tone: 'danger' });
      state.events.push({ type: 'sfx', name: 'break', x: player.x, y: player.y });
      state.events.push({ type: 'drop', what: spec.name });
      weapon.melee = 'bat';
      weapon.durability = -1;
    }
  }
  makeNoise(state, player.x, player.y, loud ? MELEE_NOISE : TAKEDOWN_NOISE);
}

/** Recoger un arma cuerpo a cuerpo: reemplaza la que tienes. Devuelve el texto para el mensaje. */
export function pickMelee(state: GameState, id: MeleeId): string {
  const weapon = state.weapon;
  const old = weapon.melee;
  weapon.melee = id;
  weapon.durability = MELEES[id].durability;
  weapon.current = 'melee';
  weapon.reloadTimer = 0;
  state.events.push({ type: 'sfx', name: 'weapon', x: state.player.x, y: state.player.y });
  const article = id === 'sledge' || id === 'katana' ? 'una' : 'un';
  const swap = old !== 'bat' && old !== id ? ` (dejas: ${MELEES[old].name.toLowerCase()})` : '';
  return `${article} ${MELEES[id].name}${swap} [1]`;
}

/** Recoger una especial: reemplaza la que tengas y viene cargada. */
export function pickSpecial(state: GameState, id: SpecialId): string {
  const weapon = state.weapon;
  for (const s of SPECIALS) weapon.owned[s] = false;
  weapon.owned[id] = true;
  weapon.mags[id] = GUNS[id].mag;
  weapon.current = id;
  weapon.reloadTimer = 0;
  state.events.push({ type: 'sfx', name: 'weapon', x: state.player.x, y: state.player.y });
  return `¡${id === 'minigun' ? 'una' : 'un'} ${GUNS[id].name}! [5]`;
}
