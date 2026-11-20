// Horario de evacuación: a qué hora se va cada salida.
//
// La idea del reloj: la partida transcurre en una hora "del juego" (desde las 02:00) y cada
// salida tiene hora límite. Mientras más cerca está, ANTES se va; la más lejana espera siempre.
// Así la salida cercana es una apuesta (¿llego a tiempo?) y nunca te quedas sin opciones.
//
// Cómo se calcula (todo determinista a partir del mapa, sin azar):
//  1. Distancia de cada salida = largo de la ruta más corta en tramos × (manzana + calle) tiles.
//  2. Tiempo de viaje "a pie limpio" = distancia / velocidad del jugador.
//  3. Hora límite = viaje × 5 + 3 minutos de colchón. El ×5 es para pelear, revisar autos,
//     rodear barricadas... El reloj es para presionar, no para impedir jugar.
//  4. Cada salida se va al menos 100 s después que la anterior, y se redondea a 5 minutos
//     del reloj para que se lea fácil ("sale a las 02:45").
//  5. La más lejana no tiene límite.

import type { CityLayout, ExitKind } from './cityLayout';
import { BLOCK_SIZE, STREET_WIDTH } from './tileGrid';
import { exitNodes, exitPosition, shortestPath } from './zones';

/** El reloj del juego avanza 10 veces más rápido que el real: 6 minutos reales = 1 hora. */
export const CLOCK_SCALE = 10;
/** Hora de inicio en segundos del reloj (02:00). */
export const CLOCK_START = 2 * 3600;

export interface EvacPoint {
  /** Índice en layout.exits. */
  index: number;
  kind: ExitKind;
  x: number;
  y: number;
  /** Radio de la zona de evacuación (tiles) y segundos que hay que aguantar adentro. */
  radius: number;
  hold: number;
  /** Segundos de partida (reales) en que se va, o null si espera siempre. */
  deadline: number | null;
  /** Largo de la ruta corta, en tramos. */
  edges: number;
}

const PLAYER_SPEED = 5.5;
const TRAVEL_FACTOR = 5;
const BASE_MARGIN = 180;
const MIN_GAP = 100;

export function planEvacuation(layout: CityLayout): EvacPoint[] {
  const { graph, startNode } = layout;
  const points: EvacPoint[] = layout.exits.map((exit, index) => {
    const pos = exitPosition(graph, exit);
    const path = shortestPath(graph, startNode, exitNodes(graph, exit));
    const edges = path ? path.length - 1 : 99;
    return {
      index,
      kind: exit.kind,
      x: pos.x,
      y: pos.y,
      radius: exit.kind === 'helicopter' ? 3.5 : 2.5,
      hold: exit.kind === 'helicopter' ? 8 : 5,
      deadline: null,
      edges,
    };
  });

  const byDistance = [...points].sort((a, b) => a.edges - b.edges || a.index - b.index);
  let previous = 0;
  byDistance.forEach((point, order) => {
    if (order === byDistance.length - 1) return; // la más lejana: sin límite
    const travel = (point.edges * (BLOCK_SIZE + STREET_WIDTH)) / PLAYER_SPEED;
    let deadline = Math.max(travel * TRAVEL_FACTOR + BASE_MARGIN, previous + MIN_GAP);
    // Redondeo a 5 minutos del reloj (300 s del reloj = 30 s reales).
    const step = 300 / CLOCK_SCALE;
    deadline = Math.ceil(deadline / step) * step;
    point.deadline = deadline;
    previous = deadline;
  });
  return points;
}

/** "02:37" a partir de los segundos de partida. */
export function clockText(time: number): string {
  const total = Math.floor(CLOCK_START + time * CLOCK_SCALE);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
