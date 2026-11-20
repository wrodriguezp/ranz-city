// Azar del estado DINÁMICO (zombies que deambulan, dispersión de las balas, hordas).
//
// No usamos Math.random() ni la clase Rng del mundo estático: aquí el estado del generador es
// un simple número guardado DENTRO del GameState. Así la partida completa se puede serializar
// (guardar, mandar por red) y, desde el mismo estado y las mismas entradas, se reproduce igual.
// Es mulberry32, el mismo algoritmo de world/rng.ts, pero con el estado a la vista.

export interface RandomState {
  rng: number;
}

/** Decimal en [0, 1) y avanza el estado. */
export function random(state: RandomState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Decimal en [min, max). */
export function randomRange(state: RandomState, min: number, max: number): number {
  return min + random(state) * (max - min);
}
