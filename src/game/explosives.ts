// Explosiones y lanzables: granadas, molotovs, petardos, radios, bengalas, cohetes, barriles,
// el hinchado que revienta, las rocas del tanque y el ácido del escupidor.
//
// Todo lo que se lanza es un Projectile con la misma física (arco con gravedad, rebote en las
// paredes). Lo que cambia es qué pasa al final:
//  - granada: explota cuando se acaba la mecha;
//  - molotov: se rompe al primer golpe (suelo, pared o cuerpo) y deja un charco de fuego;
//  - petardos, radio y bengala: cuando se acaba su "mecha" se vuelven un SEÑUELO (hazards.ts);
//  - roca y ácido: caen justo donde apuntaron (y marcan ese punto en el suelo para esquivarlos);
//  - cohete: vuela recto, sin gravedad, y explota al tocar algo.
//
// Una explosión es un círculo en el mundo 2D:
//  - DAÑO con caída: en el centro el máximo y hacia el borde cada vez menos (f = 1 - d/radio).
//  - EMPUJÓN hacia afuera y un salto vertical (air): los zombies salen VOLANDO. La altura es solo
//    un número más del zombie; mientras está en el aire no ataca y las balas le pasan por debajo.
//  - RUIDO enorme: todos los zombies de la zona van a mirar qué pasó. Una granada lejos de ti
//    sirve de DISTRACCIÓN: la horda va al estallido y no a ti.
//  - REACCIÓN EN CADENA: un barril dentro del radio también explota, un instante después.
//
// Las explosiones pendientes se guardan en una cola dentro del estado (no se llaman unas a otras
// directamente). Así una cadena de 6 barriles no es una recursión, se ve escalonada (cada una
// sale 0.12 s después) y la cola es serializable como el resto del estado dinámico.

import { Tile } from '../world/tileGrid';
import { solidHeight } from './collision';
import { PLAYER_RADIUS } from './player';
import { addHazard, addLure } from './hazards';
import { THROWABLES, type BlastName, type GameState, type Inventory, type Projectile, type ThrowableId } from './state';
import { damageZombie, hurtPlayer, launchZombie, makeNoise, type ZombieRuntime } from './zombies';

/** Gravedad de los objetos lanzados (tiles/s²). Más que la real: así los arcos se ven ágiles. */
const GRAVITY = 30;
const GRENADE_FUSE = 1.7;
const GRENADE_MAX_RANGE = 15;
const THROW_COOLDOWN = 0.6;
const CHAIN_DELAY = 0.12;

interface BlastSpec {
  radius: number;
  damage: number;
  /** Fracción del daño que recibe el jugador (las granadas propias duelen, pero menos). */
  playerFactor: number;
  noise: number;
}

const BLASTS: Record<BlastName, BlastSpec> = {
  grenade: { radius: 4.8, damage: 220, playerFactor: 0.25, noise: 42 },
  barrel: { radius: 5.5, damage: 260, playerFactor: 0.3, noise: 46 },
  bloater: { radius: 3.4, damage: 110, playerFactor: 0.3, noise: 20 },
  rock: { radius: 1.8, damage: 60, playerFactor: 0.45, noise: 12 },
  rocket: { radius: 5.5, damage: 320, playerFactor: 0.35, noise: 48 },
  // El tanque cae de un salto: no quema, pero manda a volar todo lo que hay alrededor.
  slam: { radius: 4.5, damage: 90, playerFactor: 0.4, noise: 14 },
};

/** Qué campo del inventario cuenta cada lanzable (para no repetir el switch). */
const THROW_COUNT: Record<ThrowableId, 'grenades' | 'molotovs' | 'firecrackers' | 'radios' | 'flares'> = {
  grenade: 'grenades',
  molotov: 'molotovs',
  firecracker: 'firecrackers',
  radio: 'radios',
  flare: 'flares',
};
export const THROW_NAMES: Record<ThrowableId, string> = {
  grenade: 'granada',
  molotov: 'molotov',
  firecracker: 'petardos',
  radio: 'radio',
  flare: 'bengala',
};
/** Mecha (segundos) de cada lanzable; los que se vuelven señuelo "se activan" al acabarse. */
const THROW_FUSE: Record<ThrowableId, number> = { grenade: GRENADE_FUSE, molotov: 99, firecracker: 1.1, radio: 1.0, flare: 0.9 };
const MOLOTOV_RADIUS = 2.8;
const MOLOTOV_TIME = 7;
const MOLOTOV_NOISE = 16;
const ACID_RADIUS = 1.7;
const ACID_TIME = 5;
const ROCKET_SPEED = 26;
const ROCKET_LIFE = 1.6;

export function throwableCount(inventory: Inventory, id: ThrowableId): number {
  return inventory[THROW_COUNT[id]];
}

export type BlastKind = keyof typeof BLASTS;

/** T: pasa al siguiente lanzable que tengas. */
export function cycleThrowable(state: GameState): void {
  const inv = state.inventory;
  const start = THROWABLES.indexOf(inv.throwable);
  for (let i = 1; i <= THROWABLES.length; i++) {
    const next = THROWABLES[(start + i) % THROWABLES.length];
    if (throwableCount(inv, next) > 0) {
      if (next !== inv.throwable) {
        inv.throwable = next;
        state.events.push({ type: 'sfx', name: 'switch', x: state.player.x, y: state.player.y });
      }
      return;
    }
  }
  state.events.push({ type: 'message', text: 'No tienes nada para lanzar' });
}

/** Si el lanzable elegido se acabó, elige el primero que quede. */
function pickAvailable(inventory: Inventory): void {
  if (throwableCount(inventory, inventory.throwable) > 0) return;
  const other = THROWABLES.find((t) => throwableCount(inventory, t) > 0);
  if (other) inventory.throwable = other;
}

/** G: lanza el lanzable elegido en arco hacia el punto del mouse (hasta 15 tiles). */
export function throwSelected(state: GameState, aimX: number, aimY: number): void {
  const { player, inventory } = state;
  if (state.weapon.cooldown > 0) return;
  pickAvailable(inventory);
  const id = inventory.throwable;
  if (throwableCount(inventory, id) <= 0) {
    state.events.push({ type: 'message', text: 'No tienes nada para lanzar' });
    return;
  }
  inventory[THROW_COUNT[id]]--;
  pickAvailable(inventory);
  state.weapon.cooldown = THROW_COOLDOWN;
  const dx = aimX - player.x;
  const dy = aimY - player.y;
  // El molotov nunca cae a tus pies (te quemarías): mínimo 3.5 tiles.
  const dist = Math.min(GRENADE_MAX_RANGE, Math.max(id === 'molotov' ? 3.5 : 1.5, Math.hypot(dx, dy)));
  const aimLen = Math.hypot(dx, dy);
  // Con el mouse encima del personaje, se lanza hacia donde mira.
  const dirX = aimLen > 0.1 ? dx / aimLen : Math.cos(player.facing);
  const dirY = aimLen > 0.1 ? dy / aimLen : Math.sin(player.facing);
  // Tiro parabólico: elegimos el tiempo de vuelo según la distancia, y de ahí sale la velocidad.
  // Para caer al suelo en T segundos partiendo a altura z0: vz = (g·T/2) - z0/T.
  const flight = 0.45 + dist * 0.035;
  const z0 = 1.2;
  // Llega un poco antes del punto: después rueda (con roce) el último tramo.
  const speed = (dist * 0.85) / flight;
  addProjectile(state, id, player.x + dirX * 0.5, player.y + dirY * 0.5, z0, dirX * speed, dirY * speed, (GRAVITY * flight) / 2 - z0 / flight, THROW_FUSE[id]);
  state.events.push({ type: 'sfx', name: 'throw', x: player.x, y: player.y });
  if (id === 'molotov') state.events.push({ type: 'sfx', name: 'ignite', x: player.x, y: player.y });
}

/** Cohete: sale recto hacia donde miras, sin gravedad. */
export function fireRocket(state: GameState, angle: number): void {
  const { player } = state;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  addProjectile(state, 'rocket', player.x + dx * 0.7, player.y + dy * 0.7, 1.15, dx * ROCKET_SPEED, dy * ROCKET_SPEED, 0, ROCKET_LIFE);
  state.events.push({ type: 'sfx', name: 'rocket', x: player.x, y: player.y });
}

/** El escupidor lanza una bola de ácido que cae justo en (toX, toY), como la roca del tanque. */
export function throwAcid(state: GameState, fromX: number, fromY: number, toX: number, toY: number): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy) || 1;
  const flight = 0.55 + dist * 0.04;
  const z0 = 1.5;
  const sx = fromX + (dx / dist) * 0.4;
  const sy = fromY + (dy / dist) * 0.4;
  addProjectile(state, 'acid', sx, sy, z0, (toX - sx) / flight, (toY - sy) / flight, (GRAVITY * flight) / 2 - z0 / flight, 99, toX, toY);
  state.events.push({ type: 'sfx', name: 'spit', x: fromX, y: fromY });
}

/** El tanque arranca un trozo de pavimento y te lo tira donde estás. */
export function throwRock(state: GameState, fromX: number, fromY: number, toX: number, toY: number): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy) || 1;
  // Sale de encima de la cabeza del tanque (la tenía levantada) y cae justo en (toX, toY).
  const flight = 0.6 + dist * 0.035;
  const z0 = 3.4;
  const sx = fromX + (dx / dist) * 0.6;
  const sy = fromY + (dy / dist) * 0.6;
  addProjectile(state, 'rock', sx, sy, z0, (toX - sx) / flight, (toY - sy) / flight, (GRAVITY * flight) / 2 - z0 / flight, 99, toX, toY);
  state.events.push({ type: 'sfx', name: 'throw', x: fromX, y: fromY });
}

/** El tanque cae de su salto: onda que lastima y lanza a todo alrededor (ver BLASTS.slam). */
export function tankSlam(state: GameState, rt: ZombieRuntime, x: number, y: number): void {
  explode(state, rt, x, y, 'slam');
}

/**
 * El tanque arranca un barril del suelo para tirártelo: deja de estar en la calle (igual que si
 * hubiera explotado, se reconstruye desde state.barrelsBlown) pero todavía no explota.
 */
export function liftBarrel(state: GameState, rt: ZombieRuntime, id: number): void {
  if (state.barrelsBlown[id]) return;
  const barrel = rt.city.barrels[id];
  state.barrelsBlown[id] = true;
  const index = barrel.y * rt.city.grid.width + barrel.x;
  rt.city.grid.tiles[index] = Tile.Sidewalk;
  rt.field.setWalkable(index, true);
  rt.noiseField.setWalkable(index, true);
  state.events.push({ type: 'barrel', id });
}

/** Mismo arco que la roca, pero revienta como un barril. */
export function throwBarrel(state: GameState, fromX: number, fromY: number, toX: number, toY: number): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy) || 1;
  const flight = 0.7 + dist * 0.04;
  const z0 = 3.4;
  const sx = fromX + (dx / dist) * 0.6;
  const sy = fromY + (dy / dist) * 0.6;
  addProjectile(state, 'barrel', sx, sy, z0, (toX - sx) / flight, (toY - sy) / flight, (GRAVITY * flight) / 2 - z0 / flight, 99, toX, toY);
  state.events.push({ type: 'sfx', name: 'throw', x: fromX, y: fromY });
}

function addProjectile(state: GameState, kind: Projectile['kind'], x: number, y: number, z: number, vx: number, vy: number, vz: number, fuse: number, targetX = x, targetY = y): void {
  state.projectiles.push({ kind, targetX, targetY, x, y, z, vx, vy, vz, fuse, landed: false });
}

/** Mueve lo que vuela, cuenta las mechas y resuelve las explosiones pendientes. */
export function updateExplosives(state: GameState, rt: ZombieRuntime, dt: number): void {
  const grid = rt.city.grid;
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const p = state.projectiles[i];
    let boom = false;
    // "Frágiles": revientan al primer golpe contra lo que sea (no rebotan).
    const fragile = p.kind === 'rock' || p.kind === 'molotov' || p.kind === 'acid' || p.kind === 'rocket' || p.kind === 'barrel';
    if (p.kind !== 'rocket') p.vz -= GRAVITY * dt;
    p.z += p.vz * dt;

    // Movimiento por ejes separados: si el siguiente tile en X es sólido, rebota en X (y lo mismo
    // en Y). Es el mismo truco que la colisión del jugador, pero para un punto.
    const nx = p.x + p.vx * dt;
    if (p.z < solidHeight(grid, Math.floor(nx), Math.floor(p.y))) {
      if (fragile) boom = true;
      p.vx *= -0.45;
    } else {
      p.x = nx;
    }
    const ny = p.y + p.vy * dt;
    if (p.z < solidHeight(grid, Math.floor(p.x), Math.floor(ny))) {
      if (fragile) boom = true;
      p.vy *= -0.45;
    } else {
      p.y = ny;
    }

    // Contra los cuerpos: la granada rebota en el zombie y cae a sus pies (no les pasa por encima);
    // la roca del tanque revienta al golpear a alguien.
    if (p.z < 1.6 && hitsBody(state, p)) {
      if (fragile) boom = true;
      else {
        p.vx *= -0.2;
        p.vy *= -0.2;
      }
    }

    if (p.z <= 0) {
      p.z = 0;
      if (fragile) {
        boom = true;
      } else {
        if (!p.landed || Math.abs(p.vz) > 3) state.events.push({ type: 'sfx', name: 'bounce', x: p.x, y: p.y });
        p.landed = true;
        // Rebote con pérdida y roce con el suelo: rueda un poco y se queda quieta.
        p.vz = Math.abs(p.vz) > 2 ? -p.vz * 0.3 : 0;
        p.vx *= 0.55;
        p.vy *= 0.55;
      }
    }
    if (p.kind !== 'rock' && p.kind !== 'acid' && p.kind !== 'molotov' && p.kind !== 'barrel') {
      p.fuse -= dt;
      if (p.fuse <= 0) boom = true;
    }
    if (boom) {
      state.projectiles.splice(i, 1);
      land(state, rt, p);
    }
  }

  // Explosiones en cola (cadenas de barriles, hinchados).
  if (state.pendingBlasts.length === 0) return;
  const ready = [];
  for (let i = state.pendingBlasts.length - 1; i >= 0; i--) {
    const b = state.pendingBlasts[i];
    b.delay -= dt;
    if (b.delay <= 0) {
      ready.push(b);
      state.pendingBlasts.splice(i, 1);
    }
  }
  for (const b of ready) explode(state, rt, b.x, b.y, b.kind);
}

/** Qué pasa cuando un proyectil termina su vuelo (o su mecha). */
function land(state: GameState, rt: ZombieRuntime, p: Projectile): void {
  switch (p.kind) {
    case 'grenade':
    case 'rock':
    case 'rocket':
      explode(state, rt, p.x, p.y, p.kind);
      break;
    case 'barrel':
      // El barril que tiró el tanque revienta donde cae.
      explode(state, rt, p.x, p.y, 'barrel');
      break;
    case 'molotov':
      // La botella se rompe y la nafta encendida se desparrama.
      addHazard(state, 'fire', p.x, p.y, MOLOTOV_RADIUS, MOLOTOV_TIME);
      makeNoise(state, p.x, p.y, MOLOTOV_NOISE, rt);
      state.events.push({ type: 'sfx', name: 'glass', x: p.x, y: p.y });
      for (const z of state.zombies) {
        if (z.hp > 0 && Math.hypot(z.x - p.x, z.y - p.y) < MOLOTOV_RADIUS + z.radius) z.burn = Math.max(z.burn, 5);
      }
      break;
    case 'acid':
      addHazard(state, 'acid', p.x, p.y, ACID_RADIUS, ACID_TIME);
      state.events.push({ type: 'sfx', name: 'spit', x: p.x, y: p.y });
      break;
    case 'firecracker':
    case 'radio':
    case 'flare':
      addLure(state, p.kind, p.x, p.y);
      break;
  }
}

function hitsBody(state: GameState, p: Projectile): boolean {
  const hitsPlayer = p.kind === 'rock' || p.kind === 'acid' || p.kind === 'barrel';
  if (hitsPlayer && Math.hypot(state.player.x - p.x, state.player.y - p.y) < PLAYER_RADIUS + 0.3) return true;
  // El ácido del escupidor no choca con los suyos; los señuelos tampoco se frenan en nadie.
  if (p.kind === 'acid' || p.kind === 'flare' || p.kind === 'radio' || p.kind === 'firecracker') return false;
  // Solo si se mueve rápido (una granada ya quieta en el suelo no "rebota" en nadie).
  if (Math.abs(p.vx) + Math.abs(p.vy) < 2) return false;
  // Recorrido directo: hay muy pocos proyectiles a la vez, y la grilla espacial puede no estar
  // armada todavía en este punto del paso (se arma dentro de updateZombies).
  for (const z of state.zombies) {
    if (z.hp > 0 && (z.kind !== 'tank' || (p.kind !== 'rock' && p.kind !== 'barrel')) && Math.abs(z.x - p.x) < 1.2 && Math.abs(z.y - p.y) < 1.2) {
      if (Math.hypot(z.x - p.x, z.y - p.y) < z.radius + 0.15) return true;
    }
  }
  return false;
}

/** Pone una explosión en la cola (la usa damageZombie al morir un hinchado). */
export function queueBlast(state: GameState, x: number, y: number, kind: BlastKind, delay = 0): void {
  state.pendingBlasts.push({ x, y, kind, delay });
}

/** Revienta un barril: deja de ser sólido y explota. */
export function blowBarrel(state: GameState, rt: ZombieRuntime, id: number, delay = 0): void {
  if (state.barrelsBlown[id]) return;
  const barrel = rt.city.barrels[id];
  state.barrelsBlown[id] = true;
  // El tile pasa a ser vereda. La grilla es del mundo estático, pero este cambio se puede
  // reconstruir siempre desde state.barrelsBlown (ver applyBarrels en simulation.ts).
  const index = barrel.y * rt.city.grid.width + barrel.x;
  rt.city.grid.tiles[index] = Tile.Sidewalk;
  rt.field.setWalkable(index, true);
  rt.noiseField.setWalkable(index, true);
  state.events.push({ type: 'barrel', id });
  queueBlast(state, barrel.x + 0.5, barrel.y + 0.5, 'barrel', delay);
}

function explode(state: GameState, rt: ZombieRuntime, x: number, y: number, kind: BlastKind): void {
  const spec = BLASTS[kind];
  state.events.push({ type: 'explosion', x, y, radius: spec.radius, kind });
  // Primero el ruido (atrae a todos al estallido) y después el daño: a los que golpea de cerca
  // damageZombie los pone a perseguir, como corresponde.
  makeNoise(state, x, y, spec.noise, rt);
  if (kind !== 'rock' && kind !== 'slam') state.noiseHeat += 2;

  for (const z of state.zombies) {
    if (z.hp <= 0) continue;
    if (kind === 'slam' && z.kind === 'tank') continue; // el que cae no se lastima
    const dx = z.x - x;
    const dy = z.y - y;
    const d = Math.hypot(dx, dy);
    if (d > spec.radius + z.radius) continue;
    const f = Math.max(0, 1 - d / (spec.radius + z.radius));
    const nx = d > 0.01 ? dx / d : Math.cos(z.id);
    const ny = d > 0.01 ? dy / d : Math.sin(z.id);
    // La roca del tanque no lastima a los suyos tanto: es para ti.
    const damage = spec.damage * (0.3 + 0.7 * f) * (kind === 'rock' || kind === 'slam' ? 0.5 : 1);
    damageZombie(state, z, damage, 0, 0, 0.8, { gib: f > 0.35, sever: f > 0.1 ? 0.5 : 0 });
    launchZombie(z, nx * (5 + 13 * f), ny * (5 + 13 * f), 5 + 9 * f);
  }

  const { player } = state;
  const pd = Math.hypot(player.x - x, player.y - y);
  if (pd < spec.radius + PLAYER_RADIUS) {
    const f = Math.max(0, 1 - pd / (spec.radius + PLAYER_RADIUS));
    hurtPlayer(state, Math.round(spec.damage * spec.playerFactor * (0.35 + 0.65 * f)));
    const nx = pd > 0.01 ? (player.x - x) / pd : 1;
    const ny = pd > 0.01 ? (player.y - y) / pd : 0;
    player.knockX += nx * (6 + 10 * f);
    player.knockY += ny * (6 + 10 * f);
    player.airV = Math.max(player.airV, 3 + 5 * f);
  }

  // Reacción en cadena.
  for (const barrel of rt.city.barrels) {
    if (state.barrelsBlown[barrel.id]) continue;
    if (Math.hypot(barrel.x + 0.5 - x, barrel.y + 0.5 - y) <= spec.radius) blowBarrel(state, rt, barrel.id, CHAIN_DELAY);
  }
}
