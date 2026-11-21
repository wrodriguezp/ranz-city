// Revisar contenedores: mantener E cerca de un auto, una caja o un cuerpo.
//
// Revisar lleva tiempo y te deja quieto: es una pequeña apuesta. Si te alcanzan mientras
// buscas, la búsqueda se corta. Algunos autos tienen alarma: el botín sale caro.

import type { Container, LootItem } from '../world/props';
import type { GameState } from './state';
import { makeNoise, type ZombieRuntime } from './zombies';

export interface LootState {
  /** searched[id] = true si el contenedor ya se revisó. */
  searched: boolean[];
  /** Contenedor que se está revisando (-1 = ninguno) y el avance 0..1. */
  target: number;
  progress: number;
}

export const SEARCH_RANGE = 1.5;
const SEARCH_TIME: Record<Container['kind'], number> = { car: 1.6, crate: 1.0, body: 1.2 };
const ALARM_NOISE = 34;

export function createLoot(count: number): LootState {
  return { searched: new Array(count).fill(false), target: -1, progress: 0 };
}

/** Distancia del punto al rectángulo del contenedor (0 si está adentro). */
function distanceTo(c: Container, x: number, y: number): number {
  const dx = Math.max(c.x - x, 0, x - (c.x + c.w));
  const dy = Math.max(c.y - y, 0, y - (c.y + c.h));
  return Math.hypot(dx, dy);
}

/** El contenedor sin revisar más cercano al alcance del jugador (o a `range` tiles), o -1. */
export function searchableNear(state: GameState, containers: readonly Container[], range = SEARCH_RANGE): number {
  const { x, y } = state.player;
  let best = -1;
  let bestDist = range;
  for (const c of containers) {
    if (state.loot.searched[c.id]) continue;
    if (Math.abs(c.x - x) > 4 || Math.abs(c.y - y) > 4) continue;
    const d = distanceTo(c, x, y);
    if (d <= bestDist) {
      bestDist = d;
      best = c.id;
    }
  }
  return best;
}

export function updateLoot(state: GameState, rt: ZombieRuntime, holding: boolean, dt: number): void {
  const loot = state.loot;
  const containers = rt.city.props;
  const near = holding ? searchableNear(state, containers) : -1;
  // Soltar E, alejarse o recibir un golpe corta la búsqueda.
  if (near === -1 || near !== loot.target || state.player.hurtTimer < 0.05) {
    loot.target = near;
    loot.progress = 0;
    if (near === -1) return;
  }
  const container = containers[near];
  loot.progress += dt / SEARCH_TIME[container.kind];
  if (loot.progress < 1) return;

  loot.searched[near] = true;
  loot.target = -1;
  loot.progress = 0;
  const found = container.loot.map((item) => give(state, item));
  if (found.length) state.events.push({ type: 'sfx', name: 'pickup', x: state.player.x, y: state.player.y });
  const what = container.kind === 'car' ? 'el auto' : container.kind === 'crate' ? 'la caja' : 'el cuerpo';
  state.events.push({
    type: 'message',
    text: found.length ? `En ${what}: ${found.join(', ')}` : `${capitalize(what)} estaba vacío`,
    tone: found.length ? 'good' : 'info',
  });
  if (container.alarm) {
    makeNoise(state, container.x + container.w / 2, container.y + container.h / 2, ALARM_NOISE, rt);
    state.noiseHeat += 8;
    state.events.push({ type: 'alarm', x: container.x + container.w / 2, y: container.y + container.h / 2 });
    state.events.push({ type: 'message', text: '¡Saltó la alarma del auto!', tone: 'danger' });
  }
}

function give(state: GameState, item: LootItem): string {
  switch (item.type) {
    case 'ammo':
      state.weapon.reserve += item.amount;
      return `${item.amount} balas`;
    case 'medkit':
      state.inventory.medkits += item.amount;
      return item.amount > 1 ? `${item.amount} botiquines` : 'un botiquín';
    case 'battery':
      state.inventory.batteries += item.amount;
      return item.amount > 1 ? `${item.amount} baterías` : 'una batería';
  }
}

function capitalize(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}

/** Texto para el HUD: qué se puede revisar y cuánto falta. */
export function searchPrompt(state: GameState, containers: readonly Container[]): { text: string; progress?: number } {
  const target = state.loot.target >= 0 ? state.loot.target : searchableNear(state, containers);
  if (target < 0) return { text: '' };
  const kind = containers[target].kind;
  const name = kind === 'car' ? 'el auto' : kind === 'crate' ? 'la caja' : 'el cuerpo';
  if (state.loot.target === target) return { text: `Registrando ${name}…`, progress: state.loot.progress };
  return { text: `<span class="key">E</span> Revisar ${name} <span class="dim">(mantener)</span>` };
}
