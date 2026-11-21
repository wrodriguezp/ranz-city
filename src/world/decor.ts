// Decoración estática que cuenta una historia (sin efecto en colisiones):
//  - Flechas pintadas por otros supervivientes que apuntan hacia la salida más cercana.
//  - Autos quemándose (humo y fuego): se ven de lejos y sirven de punto de referencia.
//  - Basura en las veredas.
// Todo sale de la seed: es parte del mundo estático.

import type { CityLayout } from './cityLayout';
import type { Container } from './props';
import type { Rng } from './rng';
import { nodeCenter, Tile, type TileGrid } from './tileGrid';
import { exitNodes } from './zones';

export interface Graffiti {
  x: number;
  y: number;
  /** Hacia dónde apunta la flecha (radianes, en el plano x/y de la grilla). */
  angle: number;
  color: number;
}

export interface BurningCar {
  /** Id del auto (Container) que se está quemando. */
  id: number;
  x: number;
  y: number;
}

export interface Trash {
  x: number;
  y: number;
  angle: number;
  size: number;
  color: number;
}

export interface Decor {
  graffiti: Graffiti[];
  burning: BurningCar[];
  trash: Trash[];
}

const GRAFFITI_CHANCE = 0.4;
const BURNING_CHANCE = 0.12;
const BURNING_MIN_DIST = 14;
const TRASH_CHANCE = 0.1;
/** Variantes de auto comunes (ambulancia y camión militar no se queman). */
const COMMON_CAR_VARIANTS = 6;
const GRAFFITI_COLORS = [0xe23b3b, 0xf2f2f2, 0x3bd16f, 0xf0c93a];
const TRASH_COLORS = [0x2a2a2e, 0x3d3a33, 0x5a5242, 0x6b6b70, 0x24301f];

export function placeDecor(
  grid: TileGrid,
  layout: CityLayout,
  props: Container[],
  spawn: { x: number; y: number },
  rng: Rng,
): Decor {
  return {
    graffiti: placeGraffiti(layout, rng.fork('graffiti')),
    burning: igniteCars(props, spawn, rng.fork('burning')),
    trash: placeTrash(grid, rng.fork('trash')),
  };
}

/**
 * BFS desde TODAS las salidas a la vez (BFS multi-origen): cada cruce queda con su distancia a
 * la salida más cercana. Una flecha en el cruce n apunta al vecino m con dist[m] < dist[n]: si
 * sigues las flechas, siempre bajas la distancia y terminas en una salida.
 */
function placeGraffiti(layout: CityLayout, rng: Rng): Graffiti[] {
  const { graph } = layout;
  const dist = new Int32Array(graph.nodeCount).fill(-1);
  const queue: number[] = [];
  for (const exit of layout.exits)
    for (const n of exitNodes(graph, exit))
      if (dist[n] === -1) {
        dist[n] = 0;
        queue.push(n);
      }
  // Vecinos por aristas abiertas (calcularlos una vez).
  const neighbors: number[][] = Array.from({ length: graph.nodeCount }, () => []);
  for (const e of graph.edges) {
    if (graph.blocked[e.id]) continue;
    neighbors[e.a].push(e.b);
    neighbors[e.b].push(e.a);
  }
  for (let head = 0; head < queue.length; head++) {
    const n = queue[head];
    for (const m of neighbors[n])
      if (dist[m] === -1) {
        dist[m] = dist[n] + 1;
        queue.push(m);
      }
  }

  const out: Graffiti[] = [];
  const color = rng.pick(GRAFFITI_COLORS); // un mismo "autor" por ciudad
  for (let n = 0; n < graph.nodeCount; n++) {
    if (dist[n] <= 0 || !rng.chance(GRAFFITI_CHANCE)) continue;
    const better = neighbors[n].filter((m) => dist[m] === dist[n] - 1);
    if (!better.length) continue;
    const m = rng.pick(better);
    const dx = graph.nodeX(m) - graph.nodeX(n);
    const dy = graph.nodeY(m) - graph.nodeY(n);
    // Pintada en la calle, un poco pasado el centro del cruce hacia donde hay que ir.
    out.push({
      x: nodeCenter(graph.nodeX(n)) + dx * 2.5,
      y: nodeCenter(graph.nodeY(n)) + dy * 2.5,
      angle: Math.atan2(dy, dx),
      color,
    });
  }
  return out;
}

/** Algunos autos comunes, lejos del inicio, arden. Su loot se quemó con ellos. */
function igniteCars(props: Container[], spawn: { x: number; y: number }, rng: Rng): BurningCar[] {
  const out: BurningCar[] = [];
  for (const c of props) {
    if (c.kind !== 'car' || c.variant >= COMMON_CAR_VARIANTS) continue;
    const x = c.x + c.w / 2;
    const y = c.y + c.h / 2;
    if (Math.hypot(x - spawn.x, y - spawn.y) < BURNING_MIN_DIST || !rng.chance(BURNING_CHANCE)) continue;
    c.loot = [];
    c.alarm = false;
    out.push({ id: c.id, x, y });
  }
  return out;
}

function placeTrash(grid: TileGrid, rng: Rng): Trash[] {
  const out: Trash[] = [];
  for (let y = 0; y < grid.height; y++)
    for (let x = 0; x < grid.width; x++) {
      const tile = grid.tiles[y * grid.width + x];
      if (tile !== Tile.Sidewalk || !rng.chance(TRASH_CHANCE)) continue;
      out.push({
        x: x + 0.2 + rng.float() * 0.6,
        y: y + 0.2 + rng.float() * 0.6,
        angle: rng.float() * Math.PI,
        size: 0.15 + rng.float() * 0.3,
        color: rng.pick(TRASH_COLORS),
      });
    }
  return out;
}
