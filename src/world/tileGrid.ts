// Grilla de tiles: la ciudad "pintada" celda por celda.
//
// El grafo dice QUÉ está conectado; la grilla dice DÓNDE está cada cosa en el espacio.
// Es la representación que usarán las colisiones, los zombies y la línea de visión:
// todo eso trabaja en 2D sobre esta grilla. El 3D es solo cómo la dibujamos.
//
// Medidas a lo largo de un eje (en tiles):
//
//   | calle | vereda | edificios ... | vereda | calle | vereda | ...
//   |<- 4 ->|<-------- manzana (12) -------->|<- 4 ->|
//
// La vereda pertenece a la manzana (anillo de 1 tile). Los edificios llenan todo el interior
// de la manzana, sin callejones: un callejón que atraviese la manzana conectaría dos calles
// por fuera del grafo y dejaría pasar al jugador por el costado de una barricada.

import { assignBlockKinds, buildCompound, COMPOUND_KINDS, emptySpots, Local, type BlockKind, type BlockSpots } from './blocks';
import type { CityLayout } from './cityLayout';
import type { Rng } from './rng';

export const STREET_WIDTH = 8;
export const BLOCK_SIZE = 12;
export const SIDEWALK_WIDTH = 2;
export const BARRICADE_THICKNESS = 2;
/**
 * Altura de un piso de edificio, en tiles (solo visual). Un tile es ~1 metro y el personaje mide
 * 1,6: con 3 por piso y al menos 2 pisos, el edificio más bajo ya dobla en altura al jugador.
 */
export const FLOOR_HEIGHT = 3;

export const Tile = {
  Street: 0,
  Sidewalk: 1,
  Building: 2,
  Barricade: 3,
  Plaza: 4,
  /** Auto estacionado: sólido, bloquea balas pero no la vista (es bajo). Se puede revisar. */
  Car: 5,
  /** Caja de suministros: igual que el auto, pero de un solo tile. */
  Crate: 6,
  /**
   * Barril explosivo. Sólido mientras exista; un disparo o una explosión lo revienta y el tile
   * pasa a ser vereda. Es el único tile que cambia durante la partida: cuál explotó se guarda
   * en el estado dinámico (state.barrelsBlown) y se vuelve a aplicar a la grilla desde ahí.
   */
  Barrel: 7,
  /** Cerca, reja o seto: sólido y frena a los zombies, pero se ve y se dispara a través. */
  Fence: 8,
  /** Muro alto (la obra): tapa la vista y las balas, como un edificio bajito. */
  Wall: 9,
  /** Árbol: tapa la vista (la copa) y las balas (el tronco). */
  Tree: 10,
  /** Agua del canal: no se cruza, pero se ve y se dispara por encima. */
  Water: 11,
  /** Pasto (parques): piso caminable. */
  Grass: 12,
  /** Piso de un recinto (estacionamiento, gasolinera, obra, retén): caminable. */
  Lot: 13,
  /** Sacos de arena del retén: como una barricada (bajos, frenan balas). */
  Sandbag: 14,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

/** ¿Se camina por encima? (calle, vereda, plaza, pasto o piso de recinto). */
export function isFloorTile(tile: number | undefined): boolean {
  return tile === Tile.Street || tile === Tile.Sidewalk || tile === Tile.Plaza || tile === Tile.Grass || tile === Tile.Lot;
}

/** Rectángulo en coordenadas de tile: [x, x+w) × [y, y+h). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Building extends Rect {
  floors: number;
  /** Solo para dibujar: casas con techo, la tienda de la gasolinera, el hospital, carpas. */
  style?: 'house' | 'shop' | 'hospital' | 'tent';
}

/** Altura visual de un edificio (tiles). */
export function buildingHeight(b: Building): number {
  if (b.style === 'tent') return 2.2;
  return b.floors * FLOOR_HEIGHT;
}

/** Cómo se ve una calle cortada (solo visual: en la lógica todas son Tile.Barricade). */
export type BarricadeStyle = 'barrier' | 'bus' | 'rubble' | 'crash' | 'police';

export interface TileGrid {
  width: number;
  height: number;
  /** tiles[y * width + x] */
  tiles: Uint8Array;
  buildings: Building[];
  barricades: (Rect & { style: BarricadeStyle; dir: 'h' | 'v' })[];
  /** Rectángulo de cada manzana (incluye la vereda). */
  blocks: (Rect & { bx: number; by: number; isPlaza: boolean; kind: BlockKind; spots: BlockSpots })[];
  /** Agua del canal y puentes (para dibujarlos). */
  water: Rect[];
  bridges: Rect[];
}

/** Coordenada en tiles donde empieza el cruce número i (en x o en y). */
export function nodeStart(i: number): number {
  return i * (STREET_WIDTH + BLOCK_SIZE);
}

/** Coordenada en tiles donde empieza la manzana número i (en x o en y). */
export function blockStart(i: number): number {
  return nodeStart(i) + STREET_WIDTH;
}

/** Centro de un cruce, en tiles (con decimales). */
export function nodeCenter(i: number): number {
  return nodeStart(i) + STREET_WIDTH / 2;
}

export function tileAt(grid: TileGrid, x: number, y: number): Tile | undefined {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return undefined;
  return grid.tiles[y * grid.width + x] as Tile;
}

export function buildTileGrid(layout: CityLayout, rng: Rng, dangerOf: (bx: number, by: number) => number = () => 0): TileGrid {
  const { graph } = layout;
  const width = nodeStart(graph.nodesX - 1) + STREET_WIDTH;
  const height = nodeStart(graph.nodesY - 1) + STREET_WIDTH;
  const tiles = new Uint8Array(width * height).fill(Tile.Street);
  const fill = (rect: Rect, tile: Tile) => {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(width, rect.x + rect.w);
    const y1 = Math.min(height, rect.y + rect.h);
    for (let y = y0; y < y1; y++) tiles.fill(tile, y * width + x0, y * width + x1);
  };

  const plaza = layout.exits.find((e) => e.kind === 'helicopter')?.block;
  const buildings: Building[] = [];
  const blocks: TileGrid['blocks'] = [];
  const blocksX = graph.nodesX - 1;
  const blocksY = graph.nodesY - 1;
  const centerX = (blocksX - 1) / 2;
  const centerY = (blocksY - 1) / 2;
  const canal = layout.canal;
  const water: Rect[] = [];
  const bridges: Rect[] = [];

  // Tipo de cada manzana, con su propio PRNG (los edificios comunes siguen saliendo iguales).
  const kinds = assignBlockKinds(
    blocksX,
    blocksY,
    (bx, by) => (plaza && plaza.bx === bx && plaza.by === by ? 'plaza' : canal && canal.bx === bx ? 'canal' : null),
    dangerOf,
    rng.fork('block-kinds'),
  );
  const compoundRng = rng.fork('compounds');

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const isPlaza = plaza !== undefined && plaza.bx === bx && plaza.by === by;
      const kind = kinds[by * blocksX + bx];
      const block = { x: blockStart(bx), y: blockStart(by), w: BLOCK_SIZE, h: BLOCK_SIZE, bx, by, isPlaza, kind, spots: emptySpots() };
      blocks.push(block);

      if (kind === 'canal') {
        // Sin vereda: el agua llega hasta la calle.
        fill(block, Tile.Water);
        water.push({ x: block.x, y: block.y, w: block.w, h: block.h });
        continue;
      }
      fill(block, Tile.Sidewalk);
      const interior = shrink(block, SIDEWALK_WIDTH);
      if (isPlaza) {
        fill(interior, Tile.Plaza);
        continue;
      }
      if (COMPOUND_KINDS.includes(kind)) {
        const result = buildCompound(kind, interior, compoundRng);
        const edgeTile = kind === 'military' ? Tile.Sandbag : kind === 'construction' ? Tile.Wall : Tile.Fence;
        const floorTile = kind === 'park' ? Tile.Grass : Tile.Lot;
        for (let ly = 0; ly < interior.h; ly++) {
          for (let lx = 0; lx < interior.w; lx++) {
            const v = result.cells[ly * interior.w + lx];
            const tile =
              v === Local.Edge ? edgeTile : v === Local.Wall ? Tile.Wall : v === Local.Tree ? Tile.Tree : v === Local.Building ? Tile.Building : floorTile;
            tiles[(interior.y + ly) * width + interior.x + lx] = tile;
          }
        }
        buildings.push(...result.buildings);
        block.spots = result.spots;
        continue;
      }
      fill(interior, Tile.Building);

      // Los edificios son más altos hacia el centro (el "downtown").
      const distToCenter = Math.hypot(bx - centerX, by - centerY) / Math.hypot(centerX, centerY);
      const downtownBonus = Math.round((1 - distToCenter) * 2);
      for (const lot of splitIntoLots(interior, rng)) {
        // Barrio de casas: de un piso, con techo a cuatro aguas (lo pone el render).
        if (kind === 'houses') buildings.push({ ...lot, floors: 1, style: 'house' });
        else buildings.push({ ...lot, floors: rng.int(2, 3) + downtownBonus });
      }
    }
  }

  // Canal: los tramos que lo cruzan son agua o puente.
  if (canal) {
    const along = (edgeId: number): Rect => {
      const e = graph.edges[edgeId];
      return { x: blockStart(e.x), y: nodeStart(e.y), w: BLOCK_SIZE, h: STREET_WIDTH };
    };
    for (const id of canal.water) {
      const r = along(id);
      fill(r, Tile.Water);
      water.push(r);
    }
    for (const id of canal.bridges) bridges.push(along(id));
  }
  const canalX0 = canal ? blockStart(canal.bx) : -1;
  const canalX1 = canal ? canalX0 + BLOCK_SIZE : -1;
  const styleRng = rng.fork('barricade-styles');

  // Barricadas: un muro de BARRICADE_THICKNESS tiles en el medio de cada tramo cortado.
  // Cubre la calle y también las veredas de ambos lados, de fachada a fachada,
  // para que no quede un hueco por donde pasar.
  const barricades: TileGrid['barricades'] = [];
  const waterEdges = new Set(canal?.water ?? []);
  for (const edge of graph.edges) {
    if (!graph.blocked[edge.id] || waterEdges.has(edge.id)) continue;
    const mid = blockStart(edge.dir === 'h' ? edge.x : edge.y) + (BLOCK_SIZE - BARRICADE_THICKNESS) / 2;
    const across = nodeStart(edge.dir === 'h' ? edge.y : edge.x) - SIDEWALK_WIDTH;
    const span = STREET_WIDTH + SIDEWALK_WIDTH * 2;
    const rect: Rect =
      edge.dir === 'h'
        ? { x: mid, y: across, w: BARRICADE_THICKNESS, h: span }
        : { x: across, y: mid, w: span, h: BARRICADE_THICKNESS };
    let clipped = clip(rect, width, height);
    // Junto al canal la barricada termina en la orilla (no se mete en el agua).
    if (canal && edge.dir === 'v') {
      if (clipped.x < canalX1 && clipped.x + clipped.w > canalX1) clipped = { ...clipped, w: clipped.x + clipped.w - canalX1, x: canalX1 };
      else if (clipped.x < canalX0 && clipped.x + clipped.w > canalX0) clipped = { ...clipped, w: canalX0 - clipped.x };
    }
    fill(clipped, Tile.Barricade);
    const roll = styleRng.float();
    const style: BarricadeStyle = roll < 0.3 ? 'barrier' : roll < 0.48 ? 'bus' : roll < 0.66 ? 'rubble' : roll < 0.84 ? 'crash' : 'police';
    barricades.push({ ...clipped, style, dir: edge.dir });
  }

  return { width, height, tiles, buildings, barricades, blocks, water, bridges };
}

/**
 * Divide el interior de una manzana en lotes, cada uno con su edificio.
 * Tres formas posibles: un solo edificio grande, dos mitades o cuatro cuadrantes,
 * con cortes en posiciones al azar para que no queden todos iguales.
 */
function splitIntoLots(area: Rect, rng: Rng): Rect[] {
  const roll = rng.float();
  if (roll < 0.2) return [area];

  const cutX = area.x + rng.int(3, area.w - 3);
  const cutY = area.y + rng.int(3, area.h - 3);
  const left = { x: area.x, y: area.y, w: cutX - area.x, h: area.h };
  const right = { x: cutX, y: area.y, w: area.x + area.w - cutX, h: area.h };

  if (roll < 0.45) return [left, right];
  if (roll < 0.7) {
    return [
      { x: area.x, y: area.y, w: area.w, h: cutY - area.y },
      { x: area.x, y: cutY, w: area.w, h: area.y + area.h - cutY },
    ];
  }
  return [
    { ...left, h: cutY - area.y },
    { ...left, y: cutY, h: area.y + area.h - cutY },
    { ...right, h: cutY - area.y },
    { ...right, y: cutY, h: area.y + area.h - cutY },
  ];
}

function shrink(rect: Rect, by: number): Rect {
  return { x: rect.x + by, y: rect.y + by, w: rect.w - by * 2, h: rect.h - by * 2 };
}

function clip(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  return {
    x,
    y,
    w: Math.min(width, rect.x + rect.w) - x,
    h: Math.min(height, rect.y + rect.h) - y,
  };
}
