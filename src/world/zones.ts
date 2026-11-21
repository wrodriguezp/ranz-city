// Zonas de peligro y rutas: la dificultad sube a medida que te acercas a una salida.
//
// Todo se calcula sobre el GRAFO de calles, no sobre los tiles:
//  1. BFS "multi-origen" desde todas las salidas a la vez: se meten todos los cruces de salida
//     en la cola con distancia 0 y se expande igual que un BFS normal. El resultado es, para
//     cada cruce, la distancia (en tramos) a la salida MÁS CERCANA.
//  2. peligro = 1 - distancia / distanciaMáxima. Al lado de una salida vale 1; en el punto más
//     lejano de todas, 0. Cerca del inicio lo bajamos a la fuerza para que el arranque sea calmo.
//  3. Para saber el peligro en cualquier punto del mapa (no solo en los cruces) interpolamos
//     entre los 4 cruces que lo rodean (interpolación bilineal): así sube de a poco por la calle
//     y no a saltos.

import type { CityGraph } from './cityGraph';
import type { CityLayout, Exit } from './cityLayout';
import { BLOCK_SIZE, blockStart, nodeCenter, STREET_WIDTH } from './tileGrid';

export interface ZoneMap {
  /** Peligro 0..1 de cada cruce. */
  nodeDanger: Float32Array;
  nodesX: number;
  nodesY: number;
}

/** Cruces que cuentan como "la salida" para medir distancias. */
export function exitNodes(graph: CityGraph, exit: Exit): number[] {
  if (exit.kind === 'road') return [exit.node!];
  return graph.blockCorners(exit.block!.bx, exit.block!.by);
}

/** Centro de la salida en tiles (el cruce del borde, o el centro de la plaza). */
export function exitPosition(graph: CityGraph, exit: Exit): { x: number; y: number } {
  if (exit.kind === 'road') return { x: nodeCenter(graph.nodeX(exit.node!)), y: nodeCenter(graph.nodeY(exit.node!)) };
  const { bx, by } = exit.block!;
  return { x: blockStart(bx) + BLOCK_SIZE / 2, y: blockStart(by) + BLOCK_SIZE / 2 };
}

export function computeZones(layout: CityLayout): ZoneMap {
  const { graph, exits, distanceFromStart } = layout;
  const count = graph.nodeCount;

  // BFS multi-origen: todas las salidas entran a la cola con distancia 0.
  const dist = new Int32Array(count).fill(-1);
  const queue: number[] = [];
  for (const exit of exits) {
    for (const node of exitNodes(graph, exit)) {
      if (dist[node] === 0) continue;
      dist[node] = 0;
      queue.push(node);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    for (const next of neighbours(graph, node)) {
      if (dist[next] !== -1) continue;
      dist[next] = dist[node] + 1;
      queue.push(next);
    }
  }

  let maxDist = 1;
  for (const d of dist) maxDist = Math.max(maxDist, d);
  const nodeDanger = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const base = 1 - dist[i] / maxDist;
    // Los primeros 3 tramos desde el inicio son más tranquilos (rampa de 0.3 a 1).
    const calm = Math.min(1, 0.3 + distanceFromStart[i] * 0.25);
    nodeDanger[i] = base * base * calm; // al cuadrado: el peligro se concentra cerca de las salidas
  }
  return { nodeDanger, nodesX: graph.nodesX, nodesY: graph.nodesY };
}

/** Peligro 0..1 en un punto cualquiera (tiles), interpolado entre los 4 cruces vecinos. */
export function dangerAt(zones: ZoneMap, x: number, y: number): number {
  const spacing = STREET_WIDTH + BLOCK_SIZE;
  const gx = Math.min(zones.nodesX - 1.001, Math.max(0, (x - STREET_WIDTH / 2) / spacing));
  const gy = Math.min(zones.nodesY - 1.001, Math.max(0, (y - STREET_WIDTH / 2) / spacing));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (nx: number, ny: number) => zones.nodeDanger[ny * zones.nodesX + nx];
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Vecinos de un cruce por tramos no cortados. */
export function neighbours(graph: CityGraph, node: number): number[] {
  const x = graph.nodeX(node);
  const y = graph.nodeY(node);
  const result: number[] = [];
  const candidates = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ];
  for (const [nx, ny] of candidates) {
    if (nx < 0 || ny < 0 || nx >= graph.nodesX || ny >= graph.nodesY) continue;
    const other = graph.nodeId(nx, ny);
    const edge = graph.edgeBetween(node, other)!;
    if (!graph.blocked[edge.id]) result.push(other);
  }
  return result;
}

/**
 * Camino más corto (lista de cruces) de start a cualquiera de los cruces objetivo, o null.
 * Es un BFS que además recuerda de dónde vino cada nodo ("parent"); al llegar, se recorre
 * parent hacia atrás para reconstruir el camino.
 */
export function shortestPath(graph: CityGraph, start: number, targets: readonly number[]): number[] | null {
  const parent = new Int32Array(graph.nodeCount).fill(-2);
  parent[start] = -1;
  const queue = [start];
  const goal = new Set(targets);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (goal.has(node)) {
      const path = [node];
      for (let p = parent[node]; p !== -1; p = parent[p]) path.push(p);
      return path.reverse();
    }
    for (const next of neighbours(graph, node)) {
      if (parent[next] !== -2) continue;
      parent[next] = node;
      queue.push(next);
    }
  }
  return null;
}

/** Centro (en tiles) del tramo entre dos cruces vecinos. */
export function edgeMidpoint(graph: CityGraph, a: number, b: number): { x: number; y: number } {
  return {
    x: (nodeCenter(graph.nodeX(a)) + nodeCenter(graph.nodeX(b))) / 2,
    y: (nodeCenter(graph.nodeY(a)) + nodeCenter(graph.nodeY(b))) / 2,
  };
}
