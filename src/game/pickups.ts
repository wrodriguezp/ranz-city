// Lo que sueltan los zombies al morir.
//
// Matar tiene que pagar. Si no, lo único sensato es esquivar todo, y las armas sobran. Un zombie
// común suelta algo pocas veces; los especiales casi siempre; y los jefes (el tanque, la
// sonámbula) sueltan un botín grande: es la razón para pelearlos en vez de rodearlos.
//
// Es estado dinámico (no viene de la seed): una lista serializable de bolsas en el suelo. Se
// recogen solas al pasar por encima.

import type { LootItem } from '../world/props';
import { give } from './loot';
import { random } from './random';
import type { GameState, Zombie } from './state';

export interface Pickup {
  x: number;
  y: number;
  items: LootItem[];
  /** Botín de jefe: se dibuja más grande y brilla. */
  big: boolean;
}

/** Radio (tiles) en el que se recoge una bolsa al pasar. */
const PICKUP_RANGE = 1.1;
/** Como mucho tantas bolsas en el suelo (las más viejas desaparecen). */
const MAX_PICKUPS = 60;

/** Decide qué suelta un zombie que acaba de morir, y lo deja en el suelo. */
export function dropFrom(state: GameState, z: Zombie): void {
  const items = rollDrop(state, z);
  if (items.length === 0) return;
  const big = z.kind === 'tank';
  state.pickups.push({ x: z.x, y: z.y, items, big });
  if (state.pickups.length > MAX_PICKUPS) state.pickups.shift();
  if (big) state.events.push({ type: 'message', text: 'Soltó un botín grande: recógelo', tone: 'good' });
}

function rollDrop(state: GameState, z: Zombie): LootItem[] {
  const r = () => random(state);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  // Los de las oleadas finales no sueltan casi nada (para eso está la caja de munición), salvo
  // los especiales, que sueltan a veces.
  const odds = z.wave ? 0.4 : 1;
  switch (z.kind) {
    case 'walker':
      if (z.wave) return [];
      if (z.armored) return r() < 0.6 ? [{ type: 'ammo', amount: int(10, 18) }, ...(r() < 0.2 ? [{ type: 'grenade' as const, amount: 1 }] : [])] : [];
      return r() < 0.07 ? [{ type: 'ammo', amount: int(4, 8) }] : [];
    case 'runner':
      if (z.wave) return [];
      return r() < 0.12 ? [r() < 0.7 ? { type: 'ammo', amount: int(5, 9) } : { type: 'battery', amount: 1 }] : [];
    case 'bloater':
      return r() < 0.35 * odds ? [{ type: r() < 0.5 ? 'molotov' : 'grenade', amount: 1 }] : [];
    case 'screamer': {
      if (r() >= 0.65 * odds) return [];
      const items: LootItem[] = [{ type: 'ammo', amount: int(10, 16) }];
      if (r() < 0.25) items.push({ type: 'medkit', amount: 1 });
      return items;
    }
    case 'spitter':
      return r() < 0.55 * odds ? [r() < 0.6 ? { type: 'shells', amount: int(4, 8) } : { type: 'battery', amount: 1 }] : [];
    case 'tank': {
      // El jefe: siempre, y mucho. Un arma especial y, si no lo tenías, el silenciador.
      const s = r();
      return [
        { type: 'medkit', amount: 2 },
        { type: 'ammo', amount: 60 },
        { type: 'shells', amount: 16 },
        { type: 'grenade', amount: 2 },
        { type: s < 0.34 ? 'minigun' : s < 0.67 ? 'flamer' : 'rocket', amount: 1 },
        ...(state.weapon.suppressor ? [] : [{ type: 'suppressor' as const, amount: 1 }]),
      ];
    }
  }
}

/** Recoge las bolsas por las que pasa el jugador. */
export function updatePickups(state: GameState): void {
  const { x, y } = state.player;
  for (let i = state.pickups.length - 1; i >= 0; i--) {
    const p = state.pickups[i];
    if (Math.abs(p.x - x) > PICKUP_RANGE || Math.abs(p.y - y) > PICKUP_RANGE) continue;
    if (Math.hypot(p.x - x, p.y - y) > PICKUP_RANGE) continue;
    const found = p.items.map((item) => give(state, item));
    state.pickups.splice(i, 1);
    state.events.push({ type: 'sfx', name: 'pickup', x, y });
    state.events.push({ type: 'message', text: `Recogiste: ${found.join(', ')}`, tone: 'good' });
  }
}
