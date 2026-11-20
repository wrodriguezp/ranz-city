// Props con loot: autos, cajas de suministros y cuerpos de supervivientes.
//
// Todo esto es MUNDO ESTÁTICO: dónde está cada cosa y qué tiene adentro sale de la seed.
// Lo único dinámico es si ya lo revisaste (state.loot.searched), que vive en el GameState.
// Así la misma seed siempre esconde lo mismo en el mismo lugar, y repetir una partida permite
// aprender la ciudad.
//
// Autos y cajas se "estampan" en la grilla como tiles sólidos (Tile.Car, Tile.Crate): con eso
// la colisión, el campo de flujo de los zombies y las balas los respetan sin código extra.
// Los cuerpos no: están en el suelo, se pasa por encima.

import type { CityLayout } from './cityLayout';
import type { Rng } from './rng';
import { BLOCK_SIZE, blockStart, nodeStart, STREET_WIDTH, Tile, type TileGrid } from './tileGrid';
import { dangerAt, type ZoneMap } from './zones';

export type LootType = 'ammo' | 'medkit' | 'battery';
export type ContainerKind = 'car' | 'crate' | 'body';

export interface LootItem {
  type: LootType;
  amount: number;
}

export interface Container {
  id: number;
  kind: ContainerKind;
  /** Rectángulo en tiles (para el cuerpo, un tile alrededor de su centro). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Orientación, solo para dibujar (radianes). */
  angle: number;
  loot: LootItem[];
  /** Autos: al revisarlo salta la alarma (mucho ruido). Riesgo/recompensa en chiquito. */
  alarm: boolean;
  /** Índice de color, solo para dibujar. */
  variant: number;
}

const CAR_CHANCE = 0.4;
const BODY_CHANCE = 0.35;
const CRATES_PER_BLOCK_MAX = 2;
const CAR_ALARM_CHANCE = 0.18;
/** Ni autos ni cajas pegados al inicio: el arranque tiene que ser despejado. */
const CLEAR_RADIUS = 8;

export function placeProps(
  grid: TileGrid,
  layout: CityLayout,
  zones: ZoneMap,
  spawn: { x: number; y: number },
  rng: Rng,
): Container[] {
  const { graph } = layout;
  const containers: Container[] = [];
  const lootRng = rng.fork('loot');
  const add = (c: Omit<Container, 'id' | 'loot'>, guaranteed?: LootItem[]) => {
    const danger = dangerAt(zones, c.x + c.w / 2, c.y + c.h / 2);
    containers.push({ ...c, id: containers.length, loot: guaranteed ?? rollLoot(c.kind, danger, lootRng) });
  };
  const nearSpawn = (x: number, y: number) => Math.hypot(x - spawn.x, y - spawn.y) < CLEAR_RADIUS;
  const tileIs = (x: number, y: number, tile: number) => grid.tiles[y * grid.width + x] === tile;
  const stamp = (x: number, y: number, w: number, h: number, tile: number) => {
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) grid.tiles[ty * grid.width + tx] = tile;
  };

  // 1. Autos estacionados y cuerpos, tramo por tramo.
  for (const edge of graph.edges) {
    if (graph.blocked[edge.id]) continue;
    // El tramo ocupa BLOCK_SIZE tiles a lo largo y STREET_WIDTH a lo ancho.
    const along = blockStart(edge.dir === 'h' ? edge.x : edge.y);
    const across = nodeStart(edge.dir === 'h' ? edge.y : edge.x);
    const toTiles = (a: number, c: number) => (edge.dir === 'h' ? { x: a, y: c } : { x: c, y: a });

    if (rng.chance(CAR_CHANCE)) {
      // Auto de 3 × 2 en uno de los dos carriles: deja libre el otro carril (2 tiles).
      const offset = rng.int(1, BLOCK_SIZE - 4);
      const lane = rng.chance(0.5) ? 0 : 2;
      const { x, y } = toTiles(along + offset, across + lane);
      const w = edge.dir === 'h' ? 3 : 2;
      const h = edge.dir === 'h' ? 2 : 3;
      let free = !nearSpawn(x + w / 2, y + h / 2);
      for (let ty = y; ty < y + h && free; ty++) for (let tx = x; tx < x + w; tx++) if (!tileIs(tx, ty, Tile.Street)) free = false;
      if (free) {
        stamp(x, y, w, h, Tile.Car);
        add({
          kind: 'car',
          x,
          y,
          w,
          h,
          angle: (edge.dir === 'h' ? 0 : Math.PI / 2) + (rng.chance(0.5) ? Math.PI : 0),
          alarm: rng.chance(CAR_ALARM_CHANCE),
          variant: rng.int(0, 5),
        });
      }
    }

    if (rng.chance(BODY_CHANCE)) {
      const a = along + 1 + rng.float() * (BLOCK_SIZE - 2);
      const c = across + 0.5 + rng.float() * (STREET_WIDTH - 1);
      const { x, y } = toTiles(a, c);
      if (!nearSpawn(x, y) && tileIs(Math.floor(x), Math.floor(y), Tile.Street)) {
        add({ kind: 'body', x: x - 0.5, y: y - 0.5, w: 1, h: 1, angle: rng.float() * Math.PI * 2, alarm: false, variant: rng.int(0, 3) });
      }
    }
  }

  // 2. Cajas de suministros pegadas a las fachadas, sobre la vereda.
  for (const block of grid.blocks) {
    if (block.isPlaza) {
      // La plaza del helicóptero siempre tiene un pequeño depósito: munición y un botiquín.
      const corners: [number, number][] = [
        [2, 2],
        [BLOCK_SIZE - 3, BLOCK_SIZE - 3],
        [2, BLOCK_SIZE - 3],
      ];
      const guaranteed: LootItem[][] = [[{ type: 'ammo', amount: 12 }], [{ type: 'medkit', amount: 1 }], [{ type: 'battery', amount: 1 }]];
      corners.forEach(([ox, oy], i) => {
        const x = block.x + ox;
        const y = block.y + oy;
        stamp(x, y, 1, 1, Tile.Crate);
        add({ kind: 'crate', x, y, w: 1, h: 1, angle: 0, alarm: false, variant: 1 }, guaranteed[i]);
      });
      continue;
    }
    const count = rng.int(0, CRATES_PER_BLOCK_MAX);
    for (let n = 0; n < count; n++) {
      // Lado de la manzana y posición sobre él. Se evitan las esquinas (cruces) y el centro del
      // lado (offsets 4..7), donde podría haber una barricada.
      const side = rng.int(0, 3);
      const offset = rng.pick([1, 2, 3, 8, 9, 10]);
      const x = side === 0 ? block.x + offset : side === 1 ? block.x + offset : side === 2 ? block.x : block.x + BLOCK_SIZE - 1;
      const y = side === 0 ? block.y : side === 1 ? block.y + BLOCK_SIZE - 1 : block.y + offset;
      if (!tileIs(x, y, Tile.Sidewalk) || nearSpawn(x + 0.5, y + 0.5)) continue;
      stamp(x, y, 1, 1, Tile.Crate);
      add({ kind: 'crate', x, y, w: 1, h: 1, angle: rng.float() * 0.6 - 0.3, alarm: false, variant: 0 });
    }
  }

  return containers;
}

/**
 * Qué hay adentro. Cuanto más peligrosa la zona, más probable que haya algo y más cantidad:
 * el loot bueno está donde está el riesgo.
 */
function rollLoot(kind: ContainerKind, danger: number, rng: Rng): LootItem[] {
  const rolls = kind === 'car' ? 2 : 1;
  const items: LootItem[] = [];
  for (let i = 0; i < rolls; i++) {
    if (rng.chance(0.4 - 0.25 * danger)) continue; // vacío
    const r = rng.float();
    if (r < 0.5) items.push({ type: 'ammo', amount: rng.int(3, 6) + Math.round(danger * 6) });
    else if (r < 0.72 + 0.08 * danger) items.push({ type: 'medkit', amount: 1 });
    else items.push({ type: 'battery', amount: 1 });
  }
  return items;
}
