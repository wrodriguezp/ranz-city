// Línea de visión y rayos sobre la grilla de tiles.
//
// Algoritmo: DDA de Amanatides & Woo ("recorrido de grilla").
// En vez de avanzar el rayo a pasitos fijos (que se puede saltar esquinas), calcula exactamente
// cuál es el próximo borde de tile que cruza el rayo: el vertical (x) o el horizontal (y).
// tMaxX = cuánto hay que avanzar por el rayo para cruzar el próximo borde vertical,
// tMaxY = lo mismo para el horizontal. Siempre avanzamos por el menor de los dos.
// Así visitamos TODOS los tiles que toca el rayo, en orden, y ninguno más.
//
// Lo usan: la visión del jugador (qué zombies se dibujan), la vista de los zombies,
// las balas y el descubrimiento de barricadas en el mapa.

import { Tile, tileAt, type TileGrid } from '../world/tileGrid';

/**
 * Bloquea la VISTA: edificios, árboles (la copa) y los muros altos de la obra.
 * Barricadas, autos, cercas y sacos de arena son bajos y se ve por encima.
 */
export function blocksSight(tile: Tile | undefined): boolean {
  return tile === undefined || tile === Tile.Building || tile === Tile.Tree || tile === Tile.Wall;
}

/** Bloquea las BALAS: todo lo sólido menos las cercas (reja, seto) y el agua. */
export function blocksBullets(tile: Tile | undefined): boolean {
  return (
    tile === undefined ||
    tile === Tile.Building ||
    tile === Tile.Barricade ||
    tile === Tile.Car ||
    tile === Tile.Crate ||
    tile === Tile.Barrel ||
    tile === Tile.Wall ||
    tile === Tile.Tree ||
    tile === Tile.Sandbag
  );
}

/**
 * Lanza un rayo desde (x0, y0) en la dirección (dirX, dirY) normalizada y devuelve la distancia
 * hasta el primer tile que bloquea, o maxDist si no choca con nada antes.
 */
export function castRay(
  grid: TileGrid,
  x0: number,
  y0: number,
  dirX: number,
  dirY: number,
  maxDist: number,
  blocks: (tile: Tile | undefined) => boolean,
): number {
  return traceRay(grid, x0, y0, dirX, dirY, maxDist, (_tx, _ty, tile) => blocks(tile));
}

/**
 * Recorre en orden los tiles que toca el rayo y llama a visit(tx, ty, tile) en cada uno.
 * Si visit devuelve true, el rayo se detiene ahí. Devuelve la distancia recorrida.
 * (El tile de partida no se visita: el que mira siempre está parado en un tile libre).
 */
export function traceRay(
  grid: TileGrid,
  x0: number,
  y0: number,
  dirX: number,
  dirY: number,
  maxDist: number,
  visit: (tx: number, ty: number, tile: Tile | undefined) => boolean,
): number {
  let tx = Math.floor(x0);
  let ty = Math.floor(y0);
  const stepX = dirX > 0 ? 1 : -1;
  const stepY = dirY > 0 ? 1 : -1;
  // Distancia a lo largo del rayo para atravesar un tile completo en cada eje.
  const tDeltaX = dirX !== 0 ? Math.abs(1 / dirX) : Infinity;
  const tDeltaY = dirY !== 0 ? Math.abs(1 / dirY) : Infinity;
  // Distancia hasta el primer borde en cada eje.
  let tMaxX = dirX !== 0 ? (dirX > 0 ? tx + 1 - x0 : x0 - tx) * tDeltaX : Infinity;
  let tMaxY = dirY !== 0 ? (dirY > 0 ? ty + 1 - y0 : y0 - ty) * tDeltaY : Infinity;

  for (;;) {
    let t: number;
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (t >= maxDist) return maxDist;
    if (visit(tx, ty, tileAt(grid, tx, ty))) return t;
  }
}

/** ¿Hay línea de visión libre entre dos puntos? */
export function lineOfSight(
  grid: TileGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  blocks: (tile: Tile | undefined) => boolean = blocksSight,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return true;
  return castRay(grid, x0, y0, dx / dist, dy / dist, dist, blocks) >= dist;
}

/** Diferencia absoluta entre dos ángulos, en [0, π]. */
export function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}
