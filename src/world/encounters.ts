// Plan de encuentros: DÓNDE empiezan los zombies. Sale de la seed, así que es parte del mundo
// estático; los zombies en sí (vida, posición actual) son estado dinámico y se crean a partir
// de este plan al empezar la partida.

import type { CityLayout } from './cityLayout';
import type { Rng } from './rng';
import { Tile, type TileGrid } from './tileGrid';

export interface ZombieSpawn {
  x: number;
  y: number;
  kind: 'walker' | 'tank';
}

export interface EncounterPlan {
  zombies: ZombieSpawn[];
}

/** Zona segura alrededor del inicio: nadie aparece encima del jugador. */
export const SAFE_RADIUS = 22;
/** Probabilidad de un zombie por tile caminable. */
const BASE_DENSITY = 0.016;

export function planEncounters(
  grid: TileGrid,
  _layout: CityLayout,
  spawn: { x: number; y: number },
  rng: Rng,
): EncounterPlan {
  const zombies: ZombieSpawn[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const tile = grid.tiles[y * grid.width + x];
      if (tile !== Tile.Street && tile !== Tile.Sidewalk && tile !== Tile.Plaza) continue;
      if (Math.hypot(x + 0.5 - spawn.x, y + 0.5 - spawn.y) < SAFE_RADIUS) continue;
      if (rng.chance(BASE_DENSITY)) zombies.push({ x: x + 0.5, y: y + 0.5, kind: 'walker' });
    }
  }
  return { zombies };
}
