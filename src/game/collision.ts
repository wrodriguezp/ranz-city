// Colisión de un círculo contra la grilla de tiles.
//
// Idea: separar el movimiento por ejes. Primero movemos en X y, si el círculo quedó metido en un
// tile sólido, lo devolvemos hasta tocar el borde. Después hacemos lo mismo en Y.
// ¿Por qué no mover en diagonal y corregir después? Porque al chocar contra una pared en diagonal
// no sabríamos hacia qué lado empujar; separando ejes, el eje bloqueado se detiene y el otro sigue,
// y eso produce el "deslizarse pegado a la pared" que se siente natural en los juegos.
//
// Solo revisamos los tiles que tocan la caja que rodea al círculo (unos 4 a 9), no la ciudad entera.

import { Tile, tileAt, type TileGrid } from '../world/tileGrid';

export function isSolid(grid: TileGrid, tx: number, ty: number): boolean {
  const tile = tileAt(grid, tx, ty);
  // Fuera del mapa cuenta como sólido: es el muro perimetral.
  return (
    tile === undefined ||
    tile === Tile.Building ||
    tile === Tile.Barricade ||
    tile === Tile.Car ||
    tile === Tile.Crate ||
    tile === Tile.Barrel ||
    tile === Tile.Fence ||
    tile === Tile.Wall ||
    tile === Tile.Tree ||
    tile === Tile.Water ||
    tile === Tile.Sandbag
  );
}

/**
 * Hasta qué altura es sólido un tile (en tiles), para lo que vuela: una granada pasa por encima de
 * una cerca o de un auto, pero no de un edificio. El agua no frena nada en el aire.
 */
export function solidHeight(grid: TileGrid, tx: number, ty: number): number {
  const tile = tileAt(grid, tx, ty);
  switch (tile) {
    case undefined:
    case Tile.Building:
      return 99;
    case Tile.Tree:
      return 3.5;
    case Tile.Wall:
      return 2.6;
    case Tile.Barricade:
    case Tile.Car:
      return 1.4;
    case Tile.Fence:
      return 1.3;
    case Tile.Crate:
    case Tile.Barrel:
      return 1;
    case Tile.Sandbag:
      return 0.9;
    default:
      return 0;
  }
}

/** ¿El círculo pisa algún tile sólido? */
export function overlapsSolid(grid: TileGrid, x: number, y: number, r: number): boolean {
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++)
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (!isSolid(grid, tx, ty)) continue;
      const cx = Math.max(tx, Math.min(x, tx + 1));
      const cy = Math.max(ty, Math.min(y, ty + 1));
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r - 1e-6) return true;
    }
  return false;
}

/**
 * Saca un círculo de las paredes al aparecer. Primero el empuje normal; si quedó encajado en un
 * hueco más angosto que su diámetro (un hinchado entre dos cajas, por ejemplo), empujar hacia un
 * lado lo mete en el otro, así que buscamos el centro de tile libre más cercano, en anillos.
 */
export function unstuck(grid: TileGrid, x: number, y: number, r: number): { x: number; y: number } {
  const pushed = moveCircle(grid, x, y, r, 0, 0);
  if (!overlapsSolid(grid, pushed.x, pushed.y, r)) return pushed;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (let ring = 1; ring <= 4; ring++)
    for (let dy = -ring; dy <= ring; dy++)
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cx = tx + dx + 0.5;
        const cy = ty + dy + 0.5;
        if (!overlapsSolid(grid, cx, cy, r)) return { x: cx, y: cy };
      }
  return pushed;
}

/** Mueve un círculo (x, y, radio r) en (dx, dy) respetando los tiles sólidos. */
export function moveCircle(
  grid: TileGrid,
  x: number,
  y: number,
  r: number,
  dx: number,
  dy: number,
): { x: number; y: number } {
  if (dx !== 0) x = resolveAxis(grid, x + dx, y, r, dx, 'x');
  if (dy !== 0) y = resolveAxis(grid, x, y + dy, r, dy, 'y');
  return depenetrate(grid, x, y, r);
}

/**
 * Red de seguridad. En las esquinas, la corrección del eje Y puede dejar al círculo apenas
 * metido (milésimas de tile) en una esquina que el eje X ya había resuelto. Aquí empujamos al
 * círculo hacia afuera por el camino más corto: desde el punto más cercano del tile hacia el centro.
 */
function depenetrate(grid: TileGrid, x: number, y: number, r: number): { x: number; y: number } {
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (!isSolid(grid, tx, ty)) continue;
      const cx = Math.max(tx, Math.min(x, tx + 1));
      const cy = Math.max(ty, Math.min(y, ty + 1));
      const gx = x - cx;
      const gy = y - cy;
      const dist = Math.hypot(gx, gy);
      // dist === 0 significa centro dentro del tile: no pasa con pasos menores al radio.
      if (dist === 0 || dist >= r) continue;
      x = cx + (gx / dist) * r;
      y = cy + (gy / dist) * r;
    }
  }
  return { x, y };
}

/**
 * Corrige la posición en un solo eje.
 * "main" es el eje en que nos movimos y "cross" el otro.
 *
 * Para cada tile sólido que el círculo pisa hay dos casos:
 *  1. El centro del círculo está frente a la cara del tile (dentro de su rango en el eje cruzado):
 *     basta con dejarlo a distancia r de esa cara.
 *  2. El círculo toca una ESQUINA del tile: lo dejamos justo a distancia r de la esquina
 *     (Pitágoras: si la distancia en el eje cruzado es d, en el eje principal tiene que ser √(r² − d²)).
 *     Sin este caso, las esquinas se sentirían cuadradas y el círculo se engancharía en ellas.
 */
function resolveAxis(grid: TileGrid, x: number, y: number, r: number, delta: number, axis: 'x' | 'y'): number {
  let main = axis === 'x' ? x : y;
  const cross = axis === 'x' ? y : x;

  const minMain = Math.floor(main - r);
  const maxMain = Math.floor(main + r);
  const minCross = Math.floor(cross - r);
  const maxCross = Math.floor(cross + r);

  for (let m = minMain; m <= maxMain; m++) {
    for (let c = minCross; c <= maxCross; c++) {
      const solid = axis === 'x' ? isSolid(grid, m, c) : isSolid(grid, c, m);
      if (!solid) continue;
      // Solo importan los tiles cuya cara está POR DELANTE del centro en la dirección del movimiento.
      // Un tile que queda detrás o al lado (por ejemplo, la pared por la que nos deslizamos) se
      // resuelve en el otro eje; si lo procesáramos aquí, un error de redondeo de 1e-16 bastaría
      // para "chocar" con él y saltar un tile entero. Como avanzamos menos que el radio por paso,
      // el centro nunca alcanza a cruzar la cara de un tile.
      if (delta > 0 ? m < main : m + 1 > main) continue;

      // Punto del tile más cercano al centro del círculo. Si está a menos de r, hay choque.
      const closestCross = Math.max(c, Math.min(cross, c + 1));
      const closestMain = Math.max(m, Math.min(main, m + 1));
      const crossGap = cross - closestCross;
      const mainGap = main - closestMain;
      if (crossGap * crossGap + mainGap * mainGap >= r * r) continue; // no lo toca

      // Cuánto tiene que separarse del borde en el eje principal (caso 1 o caso 2).
      const clearance = crossGap === 0 ? r : Math.sqrt(r * r - crossGap * crossGap);

      if (delta > 0) {
        // Íbamos en sentido positivo: chocamos con la cara "izquierda/superior" del tile (m).
        const limit = m - clearance;
        if (main > limit) main = limit;
      } else {
        // Sentido negativo: chocamos con la cara opuesta (m + 1).
        const limit = m + 1 + clearance;
        if (main < limit) main = limit;
      }
    }
  }
  return main;
}
