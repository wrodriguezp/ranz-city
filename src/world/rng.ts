// Generador de números pseudoaleatorios (PRNG) determinista.
//
// La idea clave: Math.random() da números distintos en cada ejecución, así que dos jugadores
// (o la misma partida repetida) verían ciudades distintas. Un PRNG con seed, en cambio, es una
// función pura: a partir del mismo estado inicial produce SIEMPRE la misma secuencia de números.
// Por eso, todo el azar del mundo estático tiene que salir de aquí y nunca de Math.random().

/**
 * mulberry32: un PRNG de 32 bits muy pequeño y rápido.
 * Cada llamada avanza el estado sumándole una constante y luego "revuelve" los bits
 * con multiplicaciones y desplazamientos (xorshift). No sirve para criptografía,
 * pero para generar mundos es más que suficiente y tiene buena distribución.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // Resultado en [0, 1)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convierte cualquier texto en una seed numérica (hash FNV-1a de 32 bits).
 * Así la seed puede ser legible, por ejemplo "zombies", y no solo un número.
 */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Envoltorio con utilidades sobre el PRNG base. */
export class Rng {
  private readonly next: () => number;

  constructor(private readonly seed: number) {
    this.next = mulberry32(seed);
  }

  /** Decimal en [0, 1). */
  float(): number {
    return this.next();
  }

  /** Entero en [min, max], ambos incluidos. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** true con probabilidad p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Un elemento al azar del arreglo. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /**
   * Baraja el arreglo en el lugar (algoritmo de Fisher-Yates).
   * Recorre de atrás hacia adelante intercambiando cada elemento con uno anterior al azar;
   * así cada permutación tiene la misma probabilidad.
   */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  /**
   * Crea un PRNG hijo e independiente para un subsistema (p. ej. "buildings").
   * La seed del hijo depende solo de la seed original y de la etiqueta, no de cuántos
   * números ya se consumieron. Así, si mañana agregamos más llamadas al azar en los edificios,
   * no cambia el resultado de las barricadas: cada subsistema tiene su propia secuencia.
   */
  fork(label: string): Rng {
    return new Rng(hashString(`${this.seed}:${label}`));
  }
}
