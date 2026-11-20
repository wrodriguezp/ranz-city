// Grafo de calles de la ciudad.
//
// La red de calles se modela como un grafo:
//   - Cada CRUCE es un nodo, ubicado en una grilla de nodesX × nodesY.
//   - Cada TRAMO de calle entre dos cruces vecinos es una arista.
// Entre cuatro cruces queda una manzana, así que hay (nodesX-1) × (nodesY-1) manzanas.
//
//   n ── n ── n        n = cruce (nodo)
//   │ ▓▓ │ ▓▓ │        ── │ = tramo de calle (arista)
//   n ── n ── n        ▓▓ = manzana
//
// Cortar una calle (poner una barricada) es simplemente marcar una arista como bloqueada.
// Pensar la ciudad como grafo hace que preguntas difíciles de responder sobre tiles
// ("¿se puede llegar a la salida?", "¿qué tan lejos está?") sean un simple BFS.

export type EdgeDir = 'h' | 'v';

export interface Edge {
  id: number;
  /** Nodo de origen (el de menor x o menor y). */
  a: number;
  /** Nodo de destino. */
  b: number;
  /** 'h' = tramo horizontal (de x a x+1), 'v' = tramo vertical (de y a y+1). */
  dir: EdgeDir;
  /** Coordenadas en la grilla de cruces del nodo de origen. */
  x: number;
  y: number;
}

export class CityGraph {
  readonly edges: Edge[] = [];
  /** blocked[edgeId] = true si el tramo está cortado por una barricada. */
  readonly blocked: boolean[];
  /** Para cada nodo, los ids de las aristas que lo tocan. */
  private readonly adjacency: number[][];

  constructor(
    readonly nodesX: number,
    readonly nodesY: number,
  ) {
    this.adjacency = Array.from({ length: nodesX * nodesY }, () => []);
    for (let y = 0; y < nodesY; y++) {
      for (let x = 0; x < nodesX; x++) {
        if (x + 1 < nodesX) this.addEdge('h', x, y, this.nodeId(x + 1, y));
        if (y + 1 < nodesY) this.addEdge('v', x, y, this.nodeId(x, y + 1));
      }
    }
    this.blocked = new Array(this.edges.length).fill(false);
  }

  get nodeCount(): number {
    return this.nodesX * this.nodesY;
  }

  nodeId(x: number, y: number): number {
    return y * this.nodesX + x;
  }

  nodeX(id: number): number {
    return id % this.nodesX;
  }

  nodeY(id: number): number {
    return Math.floor(id / this.nodesX);
  }

  /** Busca la arista entre dos nodos vecinos (o undefined si no son vecinos). */
  edgeBetween(a: number, b: number): Edge | undefined {
    for (const edgeId of this.adjacency[a]) {
      const edge = this.edges[edgeId];
      if (edge.a === b || edge.b === b) return edge;
    }
    return undefined;
  }

  /** Las cuatro aristas que rodean la manzana (bx, by). */
  blockEdges(bx: number, by: number): Edge[] {
    const topLeft = this.nodeId(bx, by);
    const topRight = this.nodeId(bx + 1, by);
    const bottomLeft = this.nodeId(bx, by + 1);
    const bottomRight = this.nodeId(bx + 1, by + 1);
    return [
      this.edgeBetween(topLeft, topRight)!,
      this.edgeBetween(bottomLeft, bottomRight)!,
      this.edgeBetween(topLeft, bottomLeft)!,
      this.edgeBetween(topRight, bottomRight)!,
    ];
  }

  /** Los cuatro cruces en las esquinas de la manzana (bx, by). */
  blockCorners(bx: number, by: number): number[] {
    return [
      this.nodeId(bx, by),
      this.nodeId(bx + 1, by),
      this.nodeId(bx, by + 1),
      this.nodeId(bx + 1, by + 1),
    ];
  }

  /**
   * BFS (búsqueda en anchura) desde un nodo, avanzando solo por tramos no bloqueados.
   *
   * Funciona como una mancha de tinta: primero visita el nodo inicial (distancia 0), luego
   * todos sus vecinos (distancia 1), luego los vecinos de esos (distancia 2), etc. Usa una
   * cola, así que siempre procesa los nodos en orden de distancia. Resultado: para cada nodo,
   * la cantidad mínima de tramos que hay que recorrer para llegar, o -1 si es inalcanzable.
   *
   * Es O(nodos + aristas): en una ciudad de 9×9 cruces son unas pocas centenas de pasos,
   * así que podemos llamarlo cientos de veces durante la generación sin problema.
   */
  bfs(start: number): Int32Array {
    const dist = new Int32Array(this.nodeCount).fill(-1);
    const queue = new Int32Array(this.nodeCount);
    let head = 0;
    let tail = 0;
    dist[start] = 0;
    queue[tail++] = start;

    while (head < tail) {
      const node = queue[head++];
      for (const edgeId of this.adjacency[node]) {
        if (this.blocked[edgeId]) continue;
        const edge = this.edges[edgeId];
        const next = edge.a === node ? edge.b : edge.a;
        if (dist[next] !== -1) continue;
        dist[next] = dist[node] + 1;
        queue[tail++] = next;
      }
    }
    return dist;
  }

  /** ¿Todos los nodos son alcanzables desde start? */
  isFullyConnected(start: number): boolean {
    return this.bfs(start).every((d) => d !== -1);
  }

  private addEdge(dir: EdgeDir, x: number, y: number, b: number): void {
    const edge: Edge = { id: this.edges.length, a: this.nodeId(x, y), b, dir, x, y };
    this.edges.push(edge);
    this.adjacency[edge.a].push(edge.id);
    this.adjacency[edge.b].push(edge.id);
  }
}
