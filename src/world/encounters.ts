// Plan de encuentros: DÓNDE empiezan los zombies. Sale de la seed, así que es parte del mundo
// estático; los zombies en sí (vida, posición actual) son estado dinámico y se crean a partir
// de este plan al empezar la partida.
//
// Tres capas:
//  1. Zombies sueltos repartidos por las calles, más densos donde el peligro es alto (zones.ts).
//  2. Un TANQUE en un "paso obligado" de la ruta corta a cada salida.
//  3. HORDAS DORMIDAS (grupos de 10-16) sobre la ruta alternativa, la larga.
// Así cada salida ofrece la elección del pilar 3: atravesar al tanque por el camino corto, o
// rodear por el largo y abrirse paso entre hordas.

import type { CityLayout } from './cityLayout';
import type { Rng } from './rng';
import { Tile, type TileGrid } from './tileGrid';
import { dangerAt, edgeMidpoint, exitNodes, shortestPath, type ZoneMap } from './zones';

export interface ZombieSpawn {
  x: number;
  y: number;
  kind: 'walker' | 'runner' | 'bloater' | 'screamer' | 'tank';
}

/**
 * Qué infectado común sale en un punto. Los especiales son más probables en zonas peligrosas.
 * (Se elige al planear, con la seed: la misma ciudad tiene siempre a los mismos en el mismo lugar).
 */
function commonKind(danger: number, rng: Rng): ZombieSpawn['kind'] {
  const r = rng.float();
  if (r < 0.08 + 0.1 * danger) return 'runner';
  if (r < 0.12 + 0.15 * danger) return 'bloater';
  if (r < 0.14 + 0.18 * danger) return 'screamer';
  return 'walker';
}

/** Un tramo de una ruta: los dos cruces que une (útil para el mapa y para depurar). */
export interface RouteInfo {
  /** Índice de la salida en layout.exits. */
  exit: number;
  /** Ruta corta (cruces) y alternativa (sin pasar por el tanque). */
  short: number[];
  long: number[] | null;
  /** Tramo donde espera el tanque, o null si la ruta es demasiado corta para tener uno. */
  tankEdge: [number, number] | null;
}

export interface EncounterPlan {
  zombies: ZombieSpawn[];
  routes: RouteInfo[];
}

/** Zona segura alrededor del inicio: nadie aparece encima del jugador. */
export const SAFE_RADIUS = 22;
/** Probabilidad de un zombie por tile caminable: base + extra × peligro. */
const BASE_DENSITY = 0.0042;
const DANGER_DENSITY = 0.016;
/** Los primeros tramos de la ruta nunca tienen tanque (no es justo encontrarlo de entrada). */
const TANK_MIN_EDGE = 2;

export function planEncounters(
  grid: TileGrid,
  layout: CityLayout,
  zones: ZoneMap,
  spawn: { x: number; y: number },
  rng: Rng,
): EncounterPlan {
  const zombies: ZombieSpawn[] = [];
  const walkable = (x: number, y: number) => {
    // Margen de medio tile con el borde: fuera de la grilla todo es sólido.
    if (x < 0.5 || y < 0.5 || x > grid.width - 0.5 || y > grid.height - 0.5) return false;
    const t = grid.tiles[Math.floor(y) * grid.width + Math.floor(x)];
    return t === Tile.Street || t === Tile.Sidewalk || t === Tile.Plaza;
  };

  // 1. Zombies sueltos.
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (!walkable(x, y)) continue;
      if (Math.hypot(x + 0.5 - spawn.x, y + 0.5 - spawn.y) < SAFE_RADIUS) continue;
      const danger = dangerAt(zones, x + 0.5, y + 0.5);
      const density = BASE_DENSITY + DANGER_DENSITY * danger;
      if (rng.chance(density)) zombies.push({ x: x + 0.5, y: y + 0.5, kind: commonKind(danger, rng) });
    }
  }

  // 2 y 3. Rutas a cada salida.
  const { graph, startNode } = layout;
  const routes: RouteInfo[] = [];
  const tankEdges = new Set<string>();
  const hordeEdges = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  layout.exits.forEach((exit, index) => {
    const targets = exitNodes(graph, exit);
    const short = shortestPath(graph, startNode, targets);
    if (!short) return;

    // ¿Dónde poner al tanque? Probamos cortar cada tramo de la ruta corta (como si el tanque
    // fuera una pared) y medimos con BFS cuánto más larga queda la mejor alternativa.
    // Elegimos el tramo que obliga al MAYOR rodeo, siempre que exista alternativa: ese es el
    // verdadero "paso obligado", el que más tienta atravesar.
    let best: { a: number; b: number; detour: number; long: number[] } | null = null;
    for (let i = TANK_MIN_EDGE; i < short.length - 1; i++) {
      const a = short[i];
      const b = short[i + 1];
      const edge = graph.edgeBetween(a, b)!;
      graph.blocked[edge.id] = true;
      const alternative = shortestPath(graph, startNode, targets);
      graph.blocked[edge.id] = false;
      if (!alternative) continue; // sin alternativa el tanque sería un muro: lo descartamos
      const detour = alternative.length - short.length;
      if (!best || detour > best.detour) best = { a, b, detour, long: alternative };
    }

    let tankEdge: [number, number] | null = null;
    if (best && !tankEdges.has(key(best.a, best.b))) {
      tankEdges.add(key(best.a, best.b));
      tankEdge = [best.a, best.b];
      const mid = edgeMidpoint(graph, best.a, best.b);
      const spot = freeSpot(mid.x, mid.y, 1.0, walkable) ?? mid;
      zombies.push({ x: spot.x, y: spot.y, kind: 'tank' });
    } else if (best) {
      tankEdge = [best.a, best.b]; // otro tanque ya cuida este tramo
    }

    // Hordas dormidas sobre la ruta larga, en tramos que la ruta corta no usa.
    const long = best?.long ?? null;
    if (long) {
      const shortEdges = new Set<string>();
      for (let i = 0; i < short.length - 1; i++) shortEdges.add(key(short[i], short[i + 1]));
      const candidates: [number, number][] = [];
      for (let i = TANK_MIN_EDGE; i < long.length - 1; i++) {
        const k = key(long[i], long[i + 1]);
        if (!shortEdges.has(k) && !hordeEdges.has(k) && !tankEdges.has(k)) candidates.push([long[i], long[i + 1]]);
      }
      const count = Math.min(candidates.length, best!.detour >= 4 ? 2 : 1);
      for (const [a, b] of rng.shuffle(candidates).slice(0, count)) {
        hordeEdges.add(key(a, b));
        const mid = edgeMidpoint(graph, a, b);
        const size = rng.int(10, 16);
        for (let n = 0; n < size; n++) {
          // Amontonados alrededor del centro del tramo, solo sobre tiles caminables.
          for (let attempt = 0; attempt < 8; attempt++) {
            const x = mid.x + (rng.float() * 2 - 1) * 4;
            const y = mid.y + (rng.float() * 2 - 1) * 4;
            if (walkable(x, y)) {
              zombies.push({ x, y, kind: 'walker' });
              break;
            }
          }
        }
      }
    }

    routes.push({ exit: index, short, long, tankEdge });
  });

  return { zombies, routes };
}

/**
 * Busca, en espiral alrededor de (x, y), un punto donde quepa un círculo de radio r sin tocar
 * nada sólido. El tanque es ancho: si su tramo tiene un auto estacionado al medio, lo corremos.
 */
function freeSpot(
  x: number,
  y: number,
  r: number,
  walkable: (x: number, y: number) => boolean,
): { x: number; y: number } | null {
  const fits = (cx: number, cy: number) => {
    for (let ty = Math.floor(cy - r); ty <= Math.floor(cy + r); ty++) {
      for (let tx = Math.floor(cx - r); tx <= Math.floor(cx + r); tx++) {
        if (!walkable(tx + 0.5, ty + 0.5)) return false;
      }
    }
    return true;
  };
  for (let radius = 0; radius <= 6; radius += 0.5) {
    const steps = Math.max(1, Math.round(radius * 8));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const cx = x + Math.cos(a) * radius;
      const cy = y + Math.sin(a) * radius;
      if (fits(cx, cy)) return { x: cx, y: cy };
    }
  }
  return null;
}
