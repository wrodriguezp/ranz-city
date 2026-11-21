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

/** ammo = balas livianas (pistola y subfusil); shells = cartuchos de escopeta. */
export type LootType =
  | 'ammo'
  | 'shells'
  | 'grenade'
  | 'molotov'
  | 'firecracker'
  | 'radio'
  | 'flare'
  | 'medkit'
  | 'battery'
  | 'shotgun'
  | 'smg'
  | 'machete'
  | 'axe'
  | 'sledge'
  | 'katana'
  | 'minigun'
  | 'flamer'
  | 'rocket';
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
const BARRELS_PER_BLOCK_MAX = 2;

/** Barril explosivo (ver Tile.Barrel). Sale de la seed, como los contenedores. */
export interface Barrel {
  id: number;
  x: number;
  y: number;
}

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
      // Auto de 3 × 2 pegado a una de las dos veredas: deja libre el resto de la calle.
      const offset = rng.int(1, BLOCK_SIZE - 4);
      const lane = rng.chance(0.5) ? 0 : STREET_WIDTH - 2;
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
      // Depósito militar: el subfusil y granadas. Llegar a la plaza tiene premio.
      const guaranteed: LootItem[][] = [
        [{ type: 'smg', amount: 1 }, { type: 'ammo', amount: 40 }],
        [{ type: 'medkit', amount: 2 }, { type: 'grenade', amount: 2 }, { type: 'molotov', amount: 1 }],
        // Y una bengala: desde la plaza se puede pedir un suministro aéreo.
        [{ type: 'shells', amount: 8 }, { type: 'battery', amount: 1 }, { type: 'flare', amount: 1 }],
      ];
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

  // 3. Herramientas de arranque: entre los contenedores más cercanos al inicio, uno tiene una
  // escopeta y otro granadas. Sin esto, la primera horda se pelea solo con bate y pistola.
  const byDistance = containers
    .filter((c) => c.kind !== 'body')
    .sort((a, b) => Math.hypot(a.x - spawn.x, a.y - spawn.y) - Math.hypot(b.x - spawn.x, b.y - spawn.y));
  byDistance[1]?.loot.push({ type: 'shotgun', amount: 1 }, { type: 'shells', amount: 10 });
  byDistance[3]?.loot.push({ type: 'grenade', amount: 2 });

  return containers;
}

/**
 * Barriles explosivos sobre las veredas, pegados a la calle. Más en las zonas peligrosas:
 * ahí es donde más se necesitan para frenar una horda.
 */
export function placeBarrels(grid: TileGrid, zones: ZoneMap, spawn: { x: number; y: number }, rng: Rng): Barrel[] {
  const barrels: Barrel[] = [];
  for (const block of grid.blocks) {
    if (block.isPlaza) continue;
    const danger = dangerAt(zones, block.x + BLOCK_SIZE / 2, block.y + BLOCK_SIZE / 2);
    const count = rng.int(0, BARRELS_PER_BLOCK_MAX) + (rng.chance(danger) ? 1 : 0);
    for (let n = 0; n < count; n++) {
      // Sobre el borde exterior de la vereda (pegado a la calle), lejos de las esquinas.
      const side = rng.int(0, 3);
      const offset = rng.int(3, BLOCK_SIZE - 4);
      const x = side === 2 ? block.x : side === 3 ? block.x + BLOCK_SIZE - 1 : block.x + offset;
      const y = side === 0 ? block.y : side === 1 ? block.y + BLOCK_SIZE - 1 : block.y + offset;
      if (Math.hypot(x + 0.5 - spawn.x, y + 0.5 - spawn.y) < 12) continue;
      if (grid.tiles[y * grid.width + x] !== Tile.Sidewalk) continue;
      grid.tiles[y * grid.width + x] = Tile.Barrel;
      barrels.push({ id: barrels.length, x, y });
    }
  }
  return barrels;
}

/**
 * Qué hay adentro. Cuanto más peligrosa la zona, más probable que haya algo y más cantidad:
 * el loot bueno está donde está el riesgo.
 */
function rollLoot(kind: ContainerKind, danger: number, rng: Rng): LootItem[] {
  // Varias "tiradas" por contenedor; la primera nunca sale vacía: revisar casi siempre paga.
  // (Un juego de supervivencia vive de la escasez, pero si 10 cajas seguidas salen vacías el
  // jugador deja de revisar, y entonces el loot deja de ser una decisión.)
  const rolls = kind === 'car' ? 3 : 2;
  const items: LootItem[] = [];
  for (let i = 0; i < rolls; i++) {
    if (i > 0 && rng.chance(0.45 - 0.2 * danger)) continue; // vacío
    const r = rng.float();
    if (r < 0.38) items.push({ type: 'ammo', amount: rng.int(6, 12) + Math.round(danger * 10) });
    else if (r < 0.52) items.push({ type: 'shells', amount: rng.int(3, 6) + Math.round(danger * 4) });
    else if (r < 0.6) items.push({ type: 'grenade', amount: 1 });
    else if (r < 0.66) items.push({ type: 'molotov', amount: 1 });
    else if (r < 0.71) items.push({ type: 'firecracker', amount: 1 });
    else if (r < 0.86) items.push({ type: 'medkit', amount: 1 });
    else items.push({ type: 'battery', amount: 1 });
  }
  // Armas: raras, más en autos (la guantera, el maletero) y en zonas peligrosas. La escopeta y
  // el subfusil salen igual de seguido.
  const weaponChance = (kind === 'car' ? 0.1 : 0.04) + 0.08 * danger;
  if (rng.chance(weaponChance)) items.push({ type: rng.chance(0.5) ? 'shotgun' : 'smg', amount: 1 });
  // Cuerpo a cuerpo: el machete y el hacha son comunes; la katana, rara. Más en cuerpos y cajas.
  const meleeChance = (kind === 'car' ? 0.05 : 0.1) + 0.05 * danger;
  if (rng.chance(meleeChance)) {
    const m = rng.float();
    items.push({ type: m < 0.35 ? 'machete' : m < 0.65 ? 'axe' : m < 0.87 ? 'sledge' : 'katana', amount: 1 });
  }
  // Una radio (en cajas) o una bengala (en zonas peligrosas): herramientas, no armas.
  if (kind === 'crate' && rng.chance(0.07)) items.push({ type: 'radio', amount: 1 });
  if (rng.chance(0.02 + 0.05 * danger)) items.push({ type: 'flare', amount: 1 });
  // Muy de vez en cuando, un arma especial en una caja de una zona peligrosa.
  if (kind === 'crate' && rng.chance(0.03 * danger)) {
    const s = rng.float();
    items.push({ type: s < 0.34 ? 'minigun' : s < 0.67 ? 'flamer' : 'rocket', amount: 1 });
  }
  return mergeLoot(items);
}

/** Junta lo repetido: "18 balas" en vez de "10 balas, 8 balas". */
function mergeLoot(items: LootItem[]): LootItem[] {
  const merged: LootItem[] = [];
  for (const item of items) {
    const same = merged.find((m) => m.type === item.type);
    if (same) same.amount += item.amount;
    else merged.push({ ...item });
  }
  return merged;
}
