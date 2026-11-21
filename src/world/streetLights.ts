// Faroles: dónde hay luz en la ciudad.
//
// La luz es parte del mundo ESTÁTICO (sale de la seed) y la usan dos cosas distintas:
//  - La LÓGICA: un zombie te ve de lejos si estás bajo un farol, aunque vayas agachado.
//    El sigilo solo sirve en la oscuridad.
//  - El RENDER: la misma información se pinta como charcos de luz cálida en el suelo.
//
// Diseño (pilar de riesgo/recompensa): el camino MÁS CORTO hacia cada salida está bien iluminado,
// con faroles a los dos lados. Es rápido, pero te ven. El resto de la ciudad tiene faroles
// sueltos, y algunos parpadean. Las calles oscuras son el camino lento del que se esconde.
//
// La luz se guarda como una grilla de números (uno por tile, 0 = oscuro, 1 = luz plena) que se
// "rasteriza" a partir de los faroles: cada farol suma un charco con caída suave hacia el borde.
// Los faroles que parpadean van en una capa aparte, porque su luz se prende y se apaga.

import type { CityLayout } from './cityLayout';
import type { Rng } from './rng';
import { BLOCK_SIZE, Tile, type TileGrid } from './tileGrid';
import { exitNodes, shortestPath } from './zones';

export interface StreetLamp {
  /** Posición del poste en tiles (con decimales: va en el borde de la vereda). */
  x: number;
  y: number;
  /** Hacia dónde cuelga la lámpara (hacia la calle), en radianes. */
  facing: number;
  flicker: boolean;
}

export interface LightMap {
  lamps: StreetLamp[];
  width: number;
  height: number;
  /** Luz de los faroles firmes, por tile (0..1). */
  steady: Float32Array;
  /** Luz de los faroles que parpadean, por tile (0..1); se multiplica por lampFlicker(time). */
  flicker: Float32Array;
}

/** Radio del charco de luz de un farol, en tiles. */
export const LAMP_RADIUS = 7;
/** Probabilidad de que un lado de manzana FUERA de las rutas tenga un farol. */
const STRAY_LAMP_CHANCE = 0.2;
const STRAY_FLICKER_CHANCE = 0.4;

export function placeStreetLights(grid: TileGrid, layout: CityLayout, rng: Rng): LightMap {
  const { graph } = layout;

  // 1. Tramos de las rutas iluminadas: el camino más corto a cada salida (BFS sobre el grafo).
  const litEdges = new Set<number>();
  for (const exit of layout.exits) {
    const path = shortestPath(graph, layout.startNode, exitNodes(graph, exit));
    if (!path) continue;
    for (let i = 1; i < path.length; i++) litEdges.add(graph.edgeBetween(path[i - 1], path[i])!.id);
  }

  // 2. Un farol va en la vereda de una manzana, del lado de la calle (un tramo del grafo).
  //    Cada manzana tiene 4 lados; cada lado da a un tramo. Los tramos de ruta llevan dos faroles
  //    por lado (y como la calle tiene manzanas a ambos lados, quedan 4 por tramo).
  const lamps: StreetLamp[] = [];
  const edge = (ax: number, ay: number, bx: number, by: number) => graph.edgeBetween(graph.nodeId(ax, ay), graph.nodeId(bx, by))!;
  for (const block of grid.blocks) {
    if (block.kind === 'canal') continue; // sin vereda: el canal queda a oscuras
    const { bx, by } = block;
    const sides = [
      { e: edge(bx, by, bx + 1, by), along: 'x', fixed: block.y + 0.6, facing: -Math.PI / 2 },
      { e: edge(bx, by + 1, bx + 1, by + 1), along: 'x', fixed: block.y + BLOCK_SIZE - 0.6, facing: Math.PI / 2 },
      { e: edge(bx, by, bx, by + 1), along: 'y', fixed: block.x + 0.6, facing: Math.PI },
      { e: edge(bx + 1, by, bx + 1, by + 1), along: 'y', fixed: block.x + BLOCK_SIZE - 0.6, facing: 0 },
    ] as const;
    for (const side of sides) {
      const start = side.along === 'x' ? block.x : block.y;
      const onRoute = litEdges.has(side.e.id) || block.isPlaza;
      let offsets: number[];
      let flicker = false;
      if (onRoute) {
        offsets = [2.5, BLOCK_SIZE - 2.5];
        // Hasta en la ruta, alguno parpadea: le da vida y no cambia mucho la luz.
        flicker = rng.chance(0.12);
      } else if (rng.chance(STRAY_LAMP_CHANCE)) {
        offsets = [3 + rng.float() * (BLOCK_SIZE - 6)];
        flicker = rng.chance(STRAY_FLICKER_CHANCE);
      } else {
        continue;
      }
      for (const offset of offsets) {
        const along = start + offset;
        lamps.push({
          x: side.along === 'x' ? along : side.fixed,
          y: side.along === 'x' ? side.fixed : along,
          facing: side.facing,
          flicker,
        });
      }
    }
  }

  const steady = new Float32Array(grid.width * grid.height);
  const flicker = new Float32Array(grid.width * grid.height);
  rasterizeLamps(lamps, grid.width, grid.height, 1, steady, flicker);
  return { lamps, width: grid.width, height: grid.height, steady, flicker };
}

/** Dónde queda el centro del charco: la lámpara cuelga hacia la calle, no sobre el poste. */
export function lampLightCenter(lamp: StreetLamp): { x: number; y: number } {
  return { x: lamp.x + Math.cos(lamp.facing) * 1.4, y: lamp.y + Math.sin(lamp.facing) * 1.4 };
}

/**
 * Pinta los charcos de luz en una grilla de `width·scale × height·scale` celdas.
 * La lógica usa scale = 1 (un valor por tile); el render, una más fina para que el borde de la luz
 * se vea suave. Caída: (1 - (d/r)²)², brillante en el centro y que se apaga sin escalón.
 */
export function rasterizeLamps(
  lamps: readonly StreetLamp[],
  width: number,
  height: number,
  scale: number,
  steady: Float32Array,
  flicker: Float32Array,
): void {
  const cols = width * scale;
  const rows = height * scale;
  for (const lamp of lamps) {
    const c = lampLightCenter(lamp);
    const target = lamp.flicker ? flicker : steady;
    const x0 = Math.max(0, Math.floor((c.x - LAMP_RADIUS) * scale));
    const x1 = Math.min(cols - 1, Math.ceil((c.x + LAMP_RADIUS) * scale));
    const y0 = Math.max(0, Math.floor((c.y - LAMP_RADIUS) * scale));
    const y1 = Math.min(rows - 1, Math.ceil((c.y + LAMP_RADIUS) * scale));
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = (gx + 0.5) / scale - c.x;
        const dy = (gy + 0.5) / scale - c.y;
        const q = (dx * dx + dy * dy) / (LAMP_RADIUS * LAMP_RADIUS);
        if (q >= 1) continue;
        const i = gy * cols + gx;
        target[i] = Math.min(1, target[i] + (1 - q) * (1 - q));
      }
    }
  }
}

/**
 * Los faroles dañados parpadean todos al mismo ritmo (la red eléctrica de la ciudad está mal).
 * Es función del tiempo, sin estado y sin azar: la lógica y el render calculan lo mismo.
 */
export function lampFlicker(time: number): number {
  const wobble = Math.sin(time * 7.3) + Math.sin(time * 17.9) * 0.7 + Math.sin(time * 2.1);
  if (wobble < -1.2) return 0;
  if (wobble < -0.9) return 0.35;
  return 1;
}

/** Luz de los faroles (0..1) en un punto del mapa, en el instante `time`. */
export function lightAt(map: LightMap, x: number, y: number, time: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return 0;
  const i = ty * map.width + tx;
  return Math.min(1, map.steady[i] + map.flicker[i] * lampFlicker(time));
}

/** Para los chequeos: ¿cuántos tiles de calle quedan con luz? */
export function litFraction(map: LightMap, grid: TileGrid): number {
  let street = 0;
  let lit = 0;
  for (let i = 0; i < grid.tiles.length; i++) {
    if (grid.tiles[i] === Tile.Building) continue;
    street++;
    if (map.steady[i] + map.flicker[i] > 0.3) lit++;
  }
  return lit / Math.max(1, street);
}
