// Explosiones: granadas, barriles, el hinchado que revienta y las rocas del tanque.
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
import { isSolid } from './collision';
import { PLAYER_RADIUS } from './player';
import type { GameState, Projectile } from './state';
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

const BLASTS: Record<'grenade' | 'barrel' | 'bloater' | 'rock', BlastSpec> = {
  grenade: { radius: 4.8, damage: 220, playerFactor: 0.25, noise: 42 },
  barrel: { radius: 5.5, damage: 260, playerFactor: 0.3, noise: 46 },
  bloater: { radius: 3.4, damage: 110, playerFactor: 0.3, noise: 20 },
  rock: { radius: 1.8, damage: 60, playerFactor: 0.45, noise: 12 },
};

export type BlastKind = keyof typeof BLASTS;

/** G: lanza una granada en arco hacia el punto del mouse (hasta 15 tiles). */
export function throwGrenade(state: GameState, aimX: number, aimY: number): void {
  const { player, inventory } = state;
  if (state.weapon.cooldown > 0) return;
  if (inventory.grenades <= 0) {
    state.events.push({ type: 'message', text: 'No tienes granadas' });
    return;
  }
  inventory.grenades--;
  state.weapon.cooldown = THROW_COOLDOWN;
  const dx = aimX - player.x;
  const dy = aimY - player.y;
  const dist = Math.min(GRENADE_MAX_RANGE, Math.max(1.5, Math.hypot(dx, dy)));
  const dirX = dx / (Math.hypot(dx, dy) || 1);
  const dirY = dy / (Math.hypot(dx, dy) || 1);
  // Tiro parabólico: elegimos el tiempo de vuelo según la distancia, y de ahí sale la velocidad.
  // Para caer al suelo en T segundos partiendo a altura z0: vz = (g·T/2) - z0/T.
  const flight = 0.45 + dist * 0.035;
  const z0 = 1.2;
  // Llega un poco antes del punto: después rueda (con roce) el último tramo.
  const speed = (dist * 0.85) / flight;
  addProjectile(state, 'grenade', player.x + dirX * 0.5, player.y + dirY * 0.5, z0, dirX * speed, dirY * speed, (GRAVITY * flight) / 2 - z0 / flight, GRENADE_FUSE);
  state.events.push({ type: 'sfx', name: 'throw', x: player.x, y: player.y });
}

/** El tanque arranca un trozo de pavimento y te lo tira donde estás. */
export function throwRock(state: GameState, fromX: number, fromY: number, toX: number, toY: number): void {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy) || 1;
  const flight = 0.55 + dist * 0.03;
  const z0 = 2.4;
  addProjectile(state, 'rock', fromX + (dx / dist) * 1.1, fromY + (dy / dist) * 1.1, z0, dx / flight, dy / flight, (GRAVITY * flight) / 2 - z0 / flight, 99);
  state.events.push({ type: 'sfx', name: 'throw', x: fromX, y: fromY });
}

function addProjectile(state: GameState, kind: Projectile['kind'], x: number, y: number, z: number, vx: number, vy: number, vz: number, fuse: number): void {
  state.projectiles.push({ kind, x, y, z, vx, vy, vz, fuse, landed: false });
}

/** Mueve lo que vuela, cuenta las mechas y resuelve las explosiones pendientes. */
export function updateExplosives(state: GameState, rt: ZombieRuntime, dt: number): void {
  const grid = rt.city.grid;
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const p = state.projectiles[i];
    let boom = false;
    p.vz -= GRAVITY * dt;
    p.z += p.vz * dt;

    // Movimiento por ejes separados: si el siguiente tile en X es sólido, rebota en X (y lo mismo
    // en Y). Es el mismo truco que la colisión del jugador, pero para un punto.
    const nx = p.x + p.vx * dt;
    if (isSolid(grid, Math.floor(nx), Math.floor(p.y)) && p.z < 3) {
      if (p.kind === 'rock') boom = true;
      p.vx *= -0.45;
    } else {
      p.x = nx;
    }
    const ny = p.y + p.vy * dt;
    if (isSolid(grid, Math.floor(p.x), Math.floor(ny)) && p.z < 3) {
      if (p.kind === 'rock') boom = true;
      p.vy *= -0.45;
    } else {
      p.y = ny;
    }

    // Contra los cuerpos: la granada rebota en el zombie y cae a sus pies (no les pasa por encima);
    // la roca del tanque revienta al golpear a alguien.
    if (p.z < 1.6 && hitsBody(state, p)) {
      if (p.kind === 'rock') boom = true;
      else {
        p.vx *= -0.2;
        p.vy *= -0.2;
      }
    }

    if (p.z <= 0) {
      p.z = 0;
      if (p.kind === 'rock') {
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
    if (p.kind === 'grenade') {
      p.fuse -= dt;
      if (p.fuse <= 0) boom = true;
    }
    if (boom) {
      state.projectiles.splice(i, 1);
      explode(state, rt, p.x, p.y, p.kind);
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

function hitsBody(state: GameState, p: Projectile): boolean {
  if (p.kind === 'rock' && Math.hypot(state.player.x - p.x, state.player.y - p.y) < PLAYER_RADIUS + 0.3) return true;
  // Solo si se mueve rápido (una granada ya quieta en el suelo no "rebota" en nadie).
  if (Math.abs(p.vx) + Math.abs(p.vy) < 2) return false;
  // Recorrido directo: hay muy pocos proyectiles a la vez, y la grilla espacial puede no estar
  // armada todavía en este punto del paso (se arma dentro de updateZombies).
  for (const z of state.zombies) {
    if (z.hp > 0 && (z.kind !== 'tank' || p.kind === 'grenade') && Math.abs(z.x - p.x) < 1.2 && Math.abs(z.y - p.y) < 1.2) {
      if (Math.hypot(z.x - p.x, z.y - p.y) < z.radius + 0.15) return p.kind === 'grenade' || z.kind !== 'tank';
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
  if (kind !== 'rock') state.noiseHeat += 2;

  for (const z of state.zombies) {
    if (z.hp <= 0) continue;
    const dx = z.x - x;
    const dy = z.y - y;
    const d = Math.hypot(dx, dy);
    if (d > spec.radius + z.radius) continue;
    const f = Math.max(0, 1 - d / (spec.radius + z.radius));
    const nx = d > 0.01 ? dx / d : Math.cos(z.id);
    const ny = d > 0.01 ? dy / d : Math.sin(z.id);
    // La roca del tanque no lastima a los suyos tanto: es para ti.
    const damage = spec.damage * (0.3 + 0.7 * f) * (kind === 'rock' ? 0.5 : 1);
    damageZombie(state, z, damage, 0, 0, 0.8, { gib: f > 0.35 });
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
