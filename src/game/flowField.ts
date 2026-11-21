// Campo de flujo (flow field): el pathfinding de las hordas.
//
// La idea: en vez de calcular un camino A* por cada zombie (300 búsquedas), hacemos UN solo BFS
// que parte desde el JUGADOR y se expande por todos los tiles caminables, anotando en cada uno
// cuántos pasos lo separan del jugador. El resultado es como un mapa de alturas con el jugador
// en el fondo del valle: cualquier zombie, esté donde esté, solo tiene que mirar sus tiles vecinos
// y moverse hacia el de menor número. "Cuesta abajo" siempre lleva al jugador, rodeando
// edificios y barricadas, porque el BFS solo avanzó por donde se puede caminar.
//
// Costo: el BFS recorre ~11.000 tiles caminables (menos de 1 ms) y solo se recalcula cuando el
// jugador cambia de tile, no en cada paso.

import { isSolid } from './collision';
import type { TileGrid } from '../world/tileGrid';

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

export class FlowField {
  /** Pasos hasta el jugador por tile; -1 = inalcanzable (o sólido). */
  readonly dist: Int32Array;
  private readonly walkable: Uint8Array;
  private readonly queue: Int32Array;
  private originTile = -1;

  constructor(private readonly grid: TileGrid) {
    const size = grid.width * grid.height;
    this.dist = new Int32Array(size).fill(-1);
    this.queue = new Int32Array(size);
    this.walkable = new Uint8Array(size);
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) this.walkable[y * grid.width + x] = isSolid(grid, x, y) ? 0 : 1;
    }
  }

  /** Recalcula el campo si el objetivo cambió de tile. */
  update(x: number, y: number): void {
    const { width, height } = this.grid;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return;
    const origin = ty * width + tx;
    if (origin === this.originTile) return;
    this.originTile = origin;

    // BFS clásico con 4 vecinos: una cola, y cada tile se visita una sola vez.
    this.dist.fill(-1);
    let headIndex = 0;
    let tail = 0;
    this.dist[origin] = 0;
    this.queue[tail++] = origin;
    while (headIndex < tail) {
      const current = this.queue[headIndex++];
      const cx = current % width;
      const cy = (current - cx) / width;
      const next = this.dist[current] + 1;
      if (cx > 0) tail = this.visit(current - 1, next, tail);
      if (cx < width - 1) tail = this.visit(current + 1, next, tail);
      if (cy > 0) tail = this.visit(current - width, next, tail);
      if (cy < height - 1) tail = this.visit(current + width, next, tail);
    }
  }

  distanceAt(x: number, y: number): number {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.grid.width || ty >= this.grid.height) return -1;
    return this.dist[ty * this.grid.width + tx];
  }

  /**
   * Dirección "cuesta abajo" desde (x, y). Devuelve false si el punto no está en el campo
   * o si ya está en el tile del jugador (ahí conviene ir directo hacia él).
   * Las diagonales solo valen si los dos tiles ortogonales están libres: si no, el zombie
   * intentaría cortar camino por la esquina de un edificio y se quedaría trabado.
   */
  direction(x: number, y: number, out: { x: number; y: number }): boolean {
    const { width, height } = this.grid;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;
    const here = this.dist[ty * width + tx];
    if (here <= 0) return false;

    let best = here;
    let bestX = 0;
    let bestY = 0;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (dx !== 0 && dy !== 0 && (!this.walkable[ty * width + nx] || !this.walkable[ny * width + tx])) continue;
      const d = this.dist[ny * width + nx];
      // Una diagonal ahorra dos pasos del BFS: la preferimos ante un empate con una ortogonal.
      if (d >= 0 && d < best) {
        best = d;
        bestX = nx;
        bestY = ny;
      }
    }
    if (best === here) return false;
    const gx = bestX + 0.5 - x;
    const gy = bestY + 0.5 - y;
    const length = Math.hypot(gx, gy) || 1;
    out.x = gx / length;
    out.y = gy / length;
    return true;
  }

  /** Un tile cambió (un barril reventó): se actualiza el mapa de pasables y se recalcula. */
  setWalkable(index: number, walkable: boolean): void {
    this.walkable[index] = walkable ? 1 : 0;
    this.originTile = -1; // el próximo update rehace el BFS
  }

  private visit(index: number, distance: number, tail: number): number {
    if (this.walkable[index] && this.dist[index] === -1) {
      this.dist[index] = distance;
      this.queue[tail++] = index;
    }
    return tail;
  }
}
