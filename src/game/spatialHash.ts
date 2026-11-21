// Grilla espacial (spatial hash) para encontrar vecinos rápido.
//
// Problema: con 300 zombies, revisar "¿choco con algún otro zombie?" comparando todos contra todos
// son 300 × 300 = 90.000 comparaciones por paso. La solución: dividir el mapa en celdas de 2×2 tiles
// y anotar qué zombies hay en cada celda. Para buscar vecinos de un zombie solo miramos su celda
// y las de alrededor: unas pocas decenas de comparaciones en vez de cientos.
//
// Implementación con "listas enlazadas en arreglos": head[celda] es el primer índice de la celda
// y next[i] el siguiente de la misma celda (-1 = fin). Reconstruirla cada paso cuesta O(n) y no
// crea objetos nuevos, así que no genera trabajo para el recolector de basura.

export class SpatialHash {
  private readonly cols: number;
  private readonly rows: number;
  private readonly head: Int32Array;
  private next = new Int32Array(256);

  constructor(
    width: number,
    height: number,
    private readonly cellSize = 2,
  ) {
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    // Vacía desde el principio (-1 = celda sin nadie): con ceros, una consulta antes del primer
    // rebuild seguiría next[0] = 0 para siempre (un golpe en el primer cuadro colgaba el juego).
    this.head = new Int32Array(this.cols * this.rows).fill(-1);
  }

  rebuild(items: readonly { x: number; y: number }[]): void {
    this.head.fill(-1);
    if (this.next.length < items.length) this.next = new Int32Array(items.length * 2);
    for (let i = 0; i < items.length; i++) {
      const cell = this.cellOf(items[i].x, items[i].y);
      this.next[i] = this.head[cell];
      this.head[cell] = i;
    }
  }

  /** Llama a visit(índice) para cada elemento cuya celda toca el círculo (x, y, radius). */
  query(x: number, y: number, radius: number, visit: (index: number) => void): void {
    const c0 = Math.max(0, Math.floor((x - radius) / this.cellSize));
    const c1 = Math.min(this.cols - 1, Math.floor((x + radius) / this.cellSize));
    const r0 = Math.max(0, Math.floor((y - radius) / this.cellSize));
    const r1 = Math.min(this.rows - 1, Math.floor((y + radius) / this.cellSize));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (let i = this.head[r * this.cols + c]; i !== -1; i = this.next[i]) visit(i);
      }
    }
  }

  private cellOf(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    return r * this.cols + c;
  }
}
