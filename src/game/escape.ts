// Escapar: la defensa final.
//
// Llegar a la salida ya no alcanza. En la zona hay una radio: mantener E pide la evacuación, y
// desde ahí hay que AGUANTAR (2:30 el helicóptero, 1:30 el camión) mientras llegan oleadas por
// el embudo de la salida (la entrada de la valla, o la única calle del callejón del camión).
// Cuando el vehículo está listo, hay que volver a la zona y quedarse unos segundos para subir.
//
// Es el momento de descargar todo: las oleadas vienen igual, así que el ruido ya no importa. Para
// eso cada salida tiene una caja de munición que se rellena (ver world/finale.ts y loot.ts).
//
// Mientras defiendes una salida, su hora límite queda en pausa: ya vienen por ti.

import type { EvacPoint } from '../world/evacuation';
import type { GameState } from './state';
import { spawnWave, type ZombieRuntime } from './zombies';

export interface DefenseState {
  /** Salida que se defiende. */
  exit: number;
  /** Segundos que faltan para que llegue el vehículo. */
  timer: number;
  /** Oleadas ya lanzadas y segundos hasta la próxima. */
  wave: number;
  waveTimer: number;
  /** ¿Ya llegó el vehículo? Desde ahí, entrar a la zona y aguantar `hold` segundos para subir. */
  ready: boolean;
}

export interface EscapeState {
  /** Avance 0..1 de la subida al vehículo en cada salida (solo cuando ya llegó). */
  progress: number[];
  /** Salidas que ya se fueron (llegaste tarde). */
  departed: boolean[];
  /** Avisos de "sale en 1 minuto" ya dados. */
  warned: boolean[];
  /** Avance 0..1 de la llamada por radio (mantener E en la zona). */
  radio: number;
  /** La defensa en curso, o null. */
  defense: DefenseState | null;
  /** ¿Empezó la defensa del helicóptero? (la música y el render lo usan). */
  finale: boolean;
  /** Salida por la que escapaste, o -1. */
  escapedVia: number;
}

const WARNING_SECONDS = 60;
/** Segundos manteniendo E para pedir la evacuación. */
const RADIO_TIME = 1.2;
/** Cada cuánto llega una oleada, y cuántos trae la primera y cuántos más cada siguiente. */
const WAVE_EVERY = { helicopter: 15, road: 14 };
const WAVE_BASE = { helicopter: 7, road: 6 };
const WAVE_GROWTH = { helicopter: 1.6, road: 2 };
const WAVE_MAX = 28;
/** En la oleada número TANK_WAVE del helicóptero viene un tanque. */
const TANK_WAVE = 6;
/** Al llegar el vehículo, una última oleada grande mientras corres a subirte. */
const LAST_WAVE = { helicopter: 22, road: 14 };
/** Las oleadas no aparecen en los últimos segundos (ya está llegando el vehículo). */
const QUIET_END = 6;

export function createEscape(points: readonly EvacPoint[]): EscapeState {
  return {
    progress: points.map(() => 0),
    departed: points.map(() => false),
    warned: points.map(() => false),
    radio: 0,
    defense: null,
    finale: false,
    escapedVia: -1,
  };
}

export function exitName(point: EvacPoint): string {
  return point.kind === 'helicopter' ? 'el helicóptero' : 'el camión de la carretera';
}

/** La salida en cuya zona está el jugador, abierta y sin defensa empezada (donde se puede usar la radio), o -1. */
export function radioExitAt(state: GameState, points: readonly EvacPoint[]): number {
  if (state.escape.defense) return -1;
  const { x, y } = state.player;
  for (const point of points) {
    if (state.escape.departed[point.index]) continue;
    if (Math.hypot(x - point.x, y - point.y) <= point.radius) return point.index;
  }
  return -1;
}

export function updateEscape(state: GameState, rt: ZombieRuntime, points: readonly EvacPoint[], holdingRadio: boolean, dt: number): void {
  const escape = state.escape;
  const { x, y } = state.player;

  // 1. Horas límite (la salida que defiendes no se va).
  for (const point of points) {
    const i = point.index;
    if (escape.departed[i] || point.deadline === null || escape.defense?.exit === i) continue;
    const left = point.deadline - state.time;
    if (left <= 0) {
      escape.departed[i] = true;
      escape.progress[i] = 0;
      state.events.push({ type: 'message', text: `Se fue ${exitName(point)}. Busca otra salida.`, tone: 'danger' });
    } else if (left <= WARNING_SECONDS && !escape.warned[i]) {
      escape.warned[i] = true;
      state.events.push({ type: 'message', text: `Radio: ${exitName(point)} sale en 1 minuto`, tone: 'danger' });
    }
  }

  // 2. La radio: mantener E en la zona de una salida pide la evacuación.
  const here = radioExitAt(state, points);
  if (here >= 0 && holdingRadio && state.player.hurtTimer >= 0.05) {
    escape.radio += dt / RADIO_TIME;
    if (escape.radio >= 1) startDefense(state, points[here]);
  } else {
    escape.radio = 0;
  }

  // 3. La defensa en curso.
  const defense = escape.defense;
  if (!defense) return;
  const point = points[defense.exit];
  const kind = point.kind;
  if (!defense.ready) {
    defense.timer -= dt;
    defense.waveTimer -= dt;
    if (defense.waveTimer <= 0 && defense.timer > QUIET_END) {
      const size = Math.min(WAVE_MAX, Math.round(WAVE_BASE[kind] + WAVE_GROWTH[kind] * defense.wave));
      const tank = kind === 'helicopter' && defense.wave === TANK_WAVE;
      spawnWave(state, rt, { x: point.x, y: point.y, dx: point.funnel.dx, dy: point.funnel.dy }, size, defense.wave, tank);
      if (tank) {
        state.events.push({ type: 'sfx', name: 'roar', x: point.x + point.funnel.dx * 25, y: point.y + point.funnel.dy * 25 });
        state.events.push({ type: 'message', text: '¡Viene un TANQUE con la oleada!', tone: 'danger' });
      } else if (defense.wave > 0 && defense.wave % 3 === 0) {
        state.events.push({ type: 'sfx', name: 'horde', x, y });
      }
      defense.wave++;
      defense.waveTimer = WAVE_EVERY[kind];
    }
    if (defense.timer <= 0) {
      defense.ready = true;
      spawnWave(state, rt, { x: point.x, y: point.y, dx: point.funnel.dx, dy: point.funnel.dy }, LAST_WAVE[kind], defense.wave + 2);
      state.events.push({ type: 'sfx', name: kind === 'helicopter' ? 'helicopter' : 'horde', x: point.x, y: point.y });
      state.events.push({
        type: 'message',
        text: kind === 'helicopter' ? '¡El helicóptero aterrizó! ¡Corre a subirte!' : '¡El camión arrancó! ¡Súbete!',
        tone: 'good',
      });
    }
    return;
  }

  // 4. El vehículo llegó: estar en la zona `hold` segundos para subir.
  const i = point.index;
  const inside = Math.hypot(x - point.x, y - point.y) <= point.radius;
  if (inside) {
    escape.progress[i] = Math.min(1, escape.progress[i] + dt / point.hold);
    if (escape.progress[i] >= 1) {
      escape.escapedVia = i;
      state.status = 'won';
    }
  } else {
    // Salir de la zona no borra todo de golpe: se va perdiendo de a poco.
    escape.progress[i] = Math.max(0, escape.progress[i] - dt * 0.25);
  }
}

function startDefense(state: GameState, point: EvacPoint): void {
  const escape = state.escape;
  escape.radio = 0;
  escape.defense = { exit: point.index, timer: point.defense, wave: 0, waveTimer: 3, ready: false };
  if (point.kind === 'helicopter') escape.finale = true;
  const m = Math.floor(point.defense / 60);
  const s = String(point.defense % 60).padStart(2, '0');
  state.events.push({ type: 'sfx', name: 'radio', x: point.x, y: point.y });
  state.events.push({
    type: 'message',
    text:
      point.kind === 'helicopter'
        ? `Radio: "El helicóptero llega en ${m}:${s}. ¡Aguanten en la plaza!"`
        : `Radio: "El camión está sin batería: ${m}:${s} para arrancarlo. ¡Cúbranlo!"`,
    tone: 'good',
  });
  state.events.push({ type: 'message', text: 'Vienen por la entrada: hay munición en la caja verde', tone: 'danger' });
}

/** Texto para el HUD mientras estás en la zona (la radio y la subida), o '' si no corresponde. */
export function escapePrompt(state: GameState, points: readonly EvacPoint[]): { text: string; progress?: number } {
  const escape = state.escape;
  const here = radioExitAt(state, points);
  if (here >= 0) {
    const what = points[here].kind === 'helicopter' ? 'el helicóptero' : 'el camión';
    if (escape.radio > 0) return { text: 'Llamando por radio…', progress: escape.radio };
    return { text: `<span class="key">E</span> Pedir ${what} por radio <span class="dim">(mantener · después hay que aguantar)</span>` };
  }
  const d = escape.defense;
  if (d?.ready && escape.progress[d.exit] > 0) return { text: 'Subiendo…', progress: escape.progress[d.exit] };
  return { text: '' };
}
