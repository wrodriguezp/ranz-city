// Revisar contenedores: mantener E cerca de un auto, una caja, un cuerpo o un suministro aéreo.
//
// Revisar lleva tiempo y te deja quieto: es una pequeña apuesta. Si te alcanzan mientras
// buscas, la búsqueda se corta. Algunos autos tienen alarma: el botín sale caro (y la alarma
// también salta si le disparas o le pegas al auto: sirve de señuelo).

import { GUNS, pickMelee, pickSpecial } from './combat';
import { addLure } from './hazards';
import type { Container, LootItem } from '../world/props';
import type { GameState } from './state';
import type { ZombieRuntime } from './zombies';

export interface LootState {
  /** searched[id] = true si el contenedor ya se revisó. */
  searched: boolean[];
  /** Contenedor que se está revisando (-1 = ninguno) y el avance 0..1. */
  target: number;
  progress: number;
  /** Suministro aéreo que se está abriendo (índice en state.drops, -1 = ninguno). */
  dropTarget: number;
}

export const SEARCH_RANGE = 1.5;
const SEARCH_TIME: Record<Container['kind'], number> = { car: 1.6, crate: 1.0, body: 1.2 };
const DROP_TIME = 1.5;

export function createLoot(count: number): LootState {
  return { searched: new Array(count).fill(false), target: -1, progress: 0, dropTarget: -1 };
}

/**
 * Hace sonar la alarma del auto que ocupa el tile (x, y), si tiene y no sonó ya. Suena un rato
 * largo (es un señuelo, ver hazards.ts): los zombies van al auto, no a ti.
 */
export function triggerCarAlarm(state: GameState, rt: ZombieRuntime, x: number, y: number): void {
  const car = rt.city.props.find((c) => c.kind === 'car' && x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
  if (!car || !car.alarm || state.alarmsFired[car.id]) return;
  state.alarmsFired[car.id] = true;
  addLure(state, 'alarm', car.x + car.w / 2, car.y + car.h / 2);
  state.noiseHeat += 6;
  state.events.push({ type: 'message', text: '¡Saltó la alarma del auto!', tone: 'danger' });
}

/** El suministro aterrizado y sin abrir más cercano al alcance, o -1. */
export function dropNear(state: GameState, range = SEARCH_RANGE + 0.4): number {
  let best = -1;
  let bestDist = range;
  state.drops.forEach((d, i) => {
    if (d.opened || d.fall > 0) return;
    const dist = Math.hypot(d.x - state.player.x, d.y - state.player.y);
    if (dist <= bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

/** Abrir un suministro: igual que un contenedor, pero es estado dinámico (no viene de la seed). */
function updateDrop(state: GameState, holding: boolean, dt: number): boolean {
  const loot = state.loot;
  const near = holding ? dropNear(state) : -1;
  if (near === -1 || near !== loot.dropTarget || state.player.hurtTimer < 0.05) {
    loot.dropTarget = near;
    if (near === -1) return false;
    loot.progress = 0;
  }
  loot.progress += dt / DROP_TIME;
  if (loot.progress < 1) return true;
  const drop = state.drops[near];
  drop.opened = true;
  loot.dropTarget = -1;
  loot.progress = 0;
  const found = drop.loot.map((item) => give(state, item));
  state.events.push({ type: 'sfx', name: 'pickup', x: state.player.x, y: state.player.y });
  state.events.push({ type: 'message', text: `Suministro: ${found.join(', ')}`, tone: 'good' });
  return true;
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
  // El suministro tiene prioridad: si estás al lado de uno, E abre ese.
  if (updateDrop(state, holding, dt)) return;
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
  if (container.alarm) triggerCarAlarm(state, rt, container.x, container.y);
}

function give(state: GameState, item: LootItem): string {
  switch (item.type) {
    case 'ammo':
      state.weapon.ammo.light += item.amount;
      return `${item.amount} balas`;
    case 'shells':
      state.weapon.ammo.shells += item.amount;
      return item.amount > 1 ? `${item.amount} cartuchos` : 'un cartucho';
    case 'grenade':
      state.inventory.grenades += item.amount;
      return item.amount > 1 ? `${item.amount} granadas` : 'una granada';
    case 'molotov':
      state.inventory.molotovs += item.amount;
      return item.amount > 1 ? `${item.amount} molotovs` : 'un molotov';
    case 'firecracker':
      state.inventory.firecrackers += item.amount;
      return item.amount > 1 ? `${item.amount} ristras de petardos` : 'petardos';
    case 'radio':
      state.inventory.radios += item.amount;
      return 'una radio a pilas';
    case 'flare':
      state.inventory.flares += item.amount;
      return item.amount > 1 ? `${item.amount} bengalas` : 'una BENGALA (pide un suministro)';
    case 'machete':
    case 'axe':
    case 'sledge':
    case 'katana':
      return pickMelee(state, item.type);
    case 'minigun':
    case 'flamer':
    case 'rocket':
      return pickSpecial(state, item.type);
    case 'shotgun':
    case 'smg': {
      const weapon = state.weapon;
      const name = item.type === 'shotgun' ? 'una ESCOPETA' : 'un SUBFUSIL';
      if (weapon.owned[item.type]) {
        // Repetida: se desarma para sacarle la munición.
        const extra = item.type === 'shotgun' ? 6 : 30;
        if (item.type === 'shotgun') weapon.ammo.shells += extra;
        else weapon.ammo.light += extra;
        return `${name} (ya tenías: +${extra} ${item.type === 'shotgun' ? 'cartuchos' : 'balas'})`;
      }
      weapon.owned[item.type] = true;
      // Viene cargada, y la tomas en la mano: es lo más emocionante que puede salir (salvo
      // que tengas una especial en la mano: esa no se suelta por una escopeta).
      weapon.mags[item.type] = GUNS[item.type].mag;
      if (weapon.current === 'pistol' || weapon.current === 'melee') weapon.current = item.type;
      weapon.reloadTimer = 0;
      state.events.push({ type: 'sfx', name: 'weapon', x: state.player.x, y: state.player.y });
      return `${name} [${item.type === 'shotgun' ? 3 : 4}]`;
    }
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
  const drop = state.loot.dropTarget >= 0 ? state.loot.dropTarget : dropNear(state);
  if (drop >= 0) {
    if (state.loot.dropTarget === drop) return { text: 'Abriendo el suministro…', progress: state.loot.progress };
    return { text: '<span class="key">E</span> Abrir el suministro <span class="dim">(mantener)</span>' };
  }
  const target = state.loot.target >= 0 ? state.loot.target : searchableNear(state, containers);
  if (target < 0) return { text: '' };
  const kind = containers[target].kind;
  const name = kind === 'car' ? 'el auto' : kind === 'crate' ? 'la caja' : 'el cuerpo';
  if (state.loot.target === target) return { text: `Registrando ${name}…`, progress: state.loot.progress };
  return { text: `<span class="key">E</span> Revisar ${name} <span class="dim">(mantener)</span>` };
}
