// Diseño de la ciudad a nivel de grafo: dónde empieza el jugador, dónde están las salidas
// y qué calles quedan cortadas. Todavía no hay tiles ni geometría: eso viene después.

import { CityGraph } from './cityGraph';
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
}

export interface CityLayout {
  graph: CityGraph;
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
  const candidates = rng.shuffle(graph.edges.filter((e) => !protectedEdges.has(e.id)));
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

  // 4. Distancias finales: sirven para mostrar qué tan lejos está cada salida
  //    y, más adelante, para subir la dificultad por zonas.
  const distanceFromStart = graph.bfs(startNode);
  const plazaDistance = Math.min(
    ...graph.blockCorners(plaza.bx, plaza.by).map((node) => distanceFromStart[node]),
  );

  const exits: Exit[] = [
    { kind: 'helicopter', block: plaza, distance: plazaDistance },
    { kind: 'road', node: roadEast, distance: distanceFromStart[roadEast] },
    { kind: 'road', node: roadSide, distance: distanceFromStart[roadSide] },
  ];

  return { graph, startNode, exits, distanceFromStart, cutCount };
}
