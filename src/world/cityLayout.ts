// Diseño de la ciudad a nivel de grafo: dónde empieza el jugador, dónde están las salidas
// y qué calles quedan cortadas. Todavía no hay tiles ni geometría: eso viene después.

import { CityGraph, type Edge } from './cityGraph';
import type { Rng } from './rng';

export type ExitKind = 'helicopter' | 'road';

export interface Exit {
  kind: ExitKind;
  /** Para 'road': el cruce del borde por donde se sale de la ciudad. */
  node?: number;
  /** Para 'helicopter': la manzana convertida en plaza. */
  block?: { bx: number; by: number };
  /** Distancia en tramos desde el inicio, ya con las calles cortadas. */
  distance: number;
  /**
   * Por dónde llegan las oleadas en la defensa final (vector unitario desde la salida hacia
   * afuera). Plaza: el lado de la ÚNICA entrada de la valla. Camión: la única calle que queda
   * abierta hacia su cruce (las otras se cortan, ver el paso 3b).
   */
  funnel: { dx: number; dy: number };
}

/**
 * Canal: una columna entera de manzanas convertida en agua. Los tramos horizontales que la
 * cruzan son agua también, salvo 2 o 3 PUENTES. Como el inicio está a la izquierda y las salidas
 * a la derecha, todo camino tiene que cruzar por un puente: son pasos obligados naturales.
 */
export interface Canal {
  /** Columna de manzanas (bx) que ocupa el agua. */
  bx: number;
  /** Ids de los tramos que son puente (abiertos). */
  bridges: number[];
  /** Ids de los tramos que son agua (bloqueados en el grafo, pero no con barricada). */
  water: number[];
}

export const CANAL_CHANCE = 0.5;

export interface CityLayout {
  graph: CityGraph;
  canal: Canal | null;
  startNode: number;
  exits: Exit[];
  /** Distancia en tramos desde el inicio hasta cada cruce (BFS final). */
  distanceFromStart: Int32Array;
  cutCount: number;
}

export interface LayoutOptions {
  /** Cruces por lado (la ciudad tiene nodesPerSide-1 manzanas por lado). */
  nodesPerSide: number;
  /** Fracción de tramos que intentamos cortar (0..1). */
  cutRatio: number;
}

export function generateLayout(rng: Rng, options: LayoutOptions): CityLayout {
  const n = options.nodesPerSide;
  const blocks = n - 1;
  const graph = new CityGraph(n, n);

  // 1. Inicio: un cruce del borde izquierdo (sin las esquinas).
  const startNode = graph.nodeId(0, rng.int(1, n - 2));

  // 2. Salidas, elegidas lejos del inicio (en la mitad derecha de la ciudad).
  //    Las elegimos ANTES de cortar calles: los cortes después respetan que sigan alcanzables.
  const roadEast = graph.nodeId(n - 1, rng.int(0, n - 1));
  const roadSide = graph.nodeId(rng.int(Math.ceil(n / 2), n - 2), rng.chance(0.5) ? 0 : n - 1);
  const plaza = {
    bx: rng.int(Math.ceil(blocks / 2) - 1, blocks - 2),
    by: rng.int(1, blocks - 2),
  };

  // Las calles alrededor de la plaza nunca se cortan: el helicóptero tiene que verse
  // y se tiene que poder llegar por cualquier lado.
  const protectedEdges = new Set(graph.blockEdges(plaza.bx, plaza.by).map((e) => e.id));

  // 2b. Canal (la mitad de las ciudades). Usa su propio PRNG hijo para no cambiar el resto.
  //     Va entre el inicio y la plaza, así el helicóptero nunca queda en el agua.
  let canal: Canal | null = null;
  const canalRng = rng.fork('canal');
  if (canalRng.chance(CANAL_CHANCE) && plaza.bx >= 2) {
    const bx = canalRng.int(1, Math.min(3, plaza.bx - 1));
    // Filas de los puentes: separadas entre sí (nunca dos seguidas) y nunca en el borde.
    const rows = canalRng.shuffle(Array.from({ length: n - 2 }, (_, i) => i + 1));
    const bridgeRows: number[] = [];
    const want = canalRng.int(2, 3);
    for (const row of rows) {
      if (bridgeRows.length >= want) break;
      if (bridgeRows.some((r) => Math.abs(r - row) < 2)) continue;
      bridgeRows.push(row);
    }
    const bridges: number[] = [];
    const water: number[] = [];
    for (let y = 0; y < n; y++) {
      const edge = graph.edgeBetween(graph.nodeId(bx, y), graph.nodeId(bx + 1, y))!;
      if (bridgeRows.includes(y)) {
        bridges.push(edge.id);
        // Los puentes no se cortan: el canal ya es bastante laberinto.
        protectedEdges.add(edge.id);
      } else {
        water.push(edge.id);
        graph.blocked[edge.id] = true;
      }
    }
    canal = { bx, bridges, water };
  }

  // 3. Cortar calles al azar sin romper la conectividad.
  //
  // Recorremos los tramos en orden aleatorio. Para cada uno: lo bloqueamos y corremos un BFS
  // desde el inicio. Si TODOS los cruces siguen siendo alcanzables, el corte se queda; si no,
  // lo deshacemos. Pedir que toda la ciudad quede conectada (y no solo las salidas) evita islas
  // de calles a las que no se puede entrar, y el resultado es un laberinto: siempre hay camino,
  // pero muchas veces no en línea recta.
  //
  // Límite teórico: un grafo conectado con V nodos necesita al menos V-1 aristas (un árbol).
  // Con 9×9 = 81 cruces y 144 tramos podríamos cortar hasta 64; el cutRatio decide cuántos
  // intentamos para que queden varias rutas posibles y no un único pasillo.
  const targetCuts = Math.floor(graph.edges.length * options.cutRatio);
  const candidates = rng.shuffle(graph.edges.filter((e) => !protectedEdges.has(e.id) && !graph.blocked[e.id]));
  let cutCount = 0;

  for (const edge of candidates) {
    if (cutCount >= targetCuts) break;
    graph.blocked[edge.id] = true;
    if (graph.isFullyConnected(startNode)) {
      cutCount++;
    } else {
      graph.blocked[edge.id] = false;
    }
  }

  // 3b. Embudo de los camiones: cada salida por carretera queda al fondo de un callejón, con
  //     UNA sola calle de acceso (la que lleva más rápido al inicio). Las otras se cortan,
  //     siempre que la ciudad siga conectada. Así, en la defensa final, la horda llega por un
  //     solo lado y tiene sentido pararse a vaciar el cargador.
  const roadFunnels = new Map<number, { dx: number; dy: number }>();
  const roadDistances = graph.bfs(startNode);
  for (const node of [roadEast, roadSide]) {
    const other = (e: Edge) => (e.a === node ? e.b : e.a);
    const incident = graph.edges
      .filter((e) => (e.a === node || e.b === node) && !graph.blocked[e.id])
      .sort((p, q) => roadDistances[other(p)] - roadDistances[other(q)] || p.id - q.id);
    for (const edge of incident.slice(1)) {
      if (protectedEdges.has(edge.id)) continue;
      graph.blocked[edge.id] = true;
      if (graph.isFullyConnected(startNode)) cutCount++;
      else graph.blocked[edge.id] = false;
    }
    const next = other(incident[0]);
    roadFunnels.set(node, { dx: graph.nodeX(next) - graph.nodeX(node), dy: graph.nodeY(next) - graph.nodeY(node) });
  }
  // La entrada de la valla de la plaza: un lado al azar (norte, sur, oeste o este).
  const plazaFunnel = rng.fork('plaza-gap').pick([
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
  ]);

  // 4. Distancias finales: sirven para mostrar qué tan lejos está cada salida
  //    y, más adelante, para subir la dificultad por zonas.
  const distanceFromStart = graph.bfs(startNode);
  const plazaDistance = Math.min(
    ...graph.blockCorners(plaza.bx, plaza.by).map((node) => distanceFromStart[node]),
  );

  const exits: Exit[] = [
    { kind: 'helicopter', block: plaza, distance: plazaDistance, funnel: plazaFunnel },
    { kind: 'road', node: roadEast, distance: distanceFromStart[roadEast], funnel: roadFunnels.get(roadEast)! },
    { kind: 'road', node: roadSide, distance: distanceFromStart[roadSide], funnel: roadFunnels.get(roadSide)! },
  ];

  return { graph, canal, startNode, exits, distanceFromStart, cutCount };
}
