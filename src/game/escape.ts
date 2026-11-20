// Escapar: llegar a una salida abierta y aguantar unos segundos adentro de su zona.
//
// Aguantar es la parte tensa: el camión o el helicóptero tarda en estar listo, y mientras tanto
// los zombies siguen llegando. Al helicóptero además lo oye toda la ciudad: al entrar a la plaza
// se dispara una horda final.

import type { EvacPoint } from '../world/evacuation';
import type { GameState } from './state';
import { spawnHorde, type ZombieRuntime } from './zombies';

export interface EscapeState {
  /** Avance 0..1 de la espera en cada salida. */
  progress: number[];
  /** Salidas que ya se fueron (llegaste tarde). */
  departed: boolean[];
  /** Avisos de "sale en 1 minuto" ya dados. */
  warned: boolean[];
  /** ¿Ya bajó el helicóptero (y vino la horda final)? */
  finale: boolean;
  /** Salida por la que escapaste, o -1. */
  escapedVia: number;
}

const WARNING_SECONDS = 60;
const FINALE_HORDE = 30;

export function createEscape(points: readonly EvacPoint[]): EscapeState {
  return {
    progress: points.map(() => 0),
    departed: points.map(() => false),
    warned: points.map(() => false),
    finale: false,
    escapedVia: -1,
  };
}

export function exitName(point: EvacPoint): string {
  return point.kind === 'helicopter' ? 'el helicóptero' : 'el camión de la carretera';
}

export function updateEscape(state: GameState, rt: ZombieRuntime, points: readonly EvacPoint[], dt: number): void {
  const escape = state.escape;
  const { x, y } = state.player;

  for (const point of points) {
    const i = point.index;
    if (escape.departed[i]) continue;

    if (point.deadline !== null) {
      const left = point.deadline - state.time;
      if (left <= 0) {
        escape.departed[i] = true;
        escape.progress[i] = 0;
        state.events.push({ type: 'message', text: `Se fue ${exitName(point)}. Busca otra salida.`, tone: 'danger' });
        continue;
      }
      if (left <= WARNING_SECONDS && !escape.warned[i]) {
        escape.warned[i] = true;
        state.events.push({ type: 'message', text: `Radio: ${exitName(point)} sale en 1 minuto`, tone: 'danger' });
      }
    }

    const inside = Math.hypot(x - point.x, y - point.y) <= point.radius;
    if (inside) {
      if (escape.progress[i] === 0) {
        state.events.push({ type: 'message', text: `¡Aguanta en la zona! ${point.hold} s`, tone: 'good' });
      }
      if (point.kind === 'helicopter' && !escape.finale) {
        escape.finale = true;
        spawnHorde(state, rt, FINALE_HORDE);
        state.events.push({ type: 'message', text: 'El ruido del helicóptero atrae a toda la ciudad', tone: 'danger' });
      }
      escape.progress[i] = Math.min(1, escape.progress[i] + dt / point.hold);
      if (escape.progress[i] >= 1) {
        escape.escapedVia = i;
        state.status = 'won';
        return;
      }
    } else {
      // Salir de la zona no borra todo de golpe: se va perdiendo de a poco.
      escape.progress[i] = Math.max(0, escape.progress[i] - dt * 0.25);
    }
  }
}
