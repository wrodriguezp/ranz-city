// Tipos de manzana: qué hay adentro de cada una.
//
// Hasta el hito 12 toda manzana era un bloque de edificios. Ahora algunas son RECINTOS: un parque,
// un estacionamiento, una gasolinera, una obra en construcción, un retén militar o un hospital.
//
// La regla de oro de los recintos: UNA SOLA ENTRADA. Si un recinto tuviera dos puertas a calles
// distintas, sería un atajo por dentro de la manzana y dejaría pasar al jugador por el costado de
// una barricada, rompiendo el laberinto que garantiza el grafo. Con una sola entrada, un recinto es
// un callejón sin salida: entrar es una decisión (hay loot, pero si te siguen quedas encerrado).
// Por la misma razón la entrada nunca está en el centro del lado, donde puede caer una barricada.
//
// Cómo se arma: cada interior (8×8 tiles) se diseña en una grilla local "canónica" con la entrada
// SIEMPRE arriba. Al final se gira (o refleja) la grilla según el lado elegido. Así cada tipo se
// programa una sola vez, sin casos por cada orientación.
//
// Conectividad: cada objeto sólido (árbol, auto, caja) se coloca "a prueba": se pone, se corre un
// BFS desde la entrada y, si quedó algún tile de piso sin poder alcanzarse, se saca. Así nunca
// queda un rincón encerrado ni una caja imposible de revisar.

import type { Rng } from './rng';
import type { Building, Rect } from './tileGrid';

export type BlockKind =
  | 'buildings'
  | 'houses'
  | 'plaza'
  | 'canal'
  | 'park'
  | 'parking'
  | 'gas'
  | 'construction'
  | 'military'
  | 'hospital';

export type CrateTier = 'normal' | 'military' | 'medical';
export type CarStyle = 'parked' | 'ambulance' | 'military';
export type SpotZombie = 'walker' | 'runner' | 'bloater' | 'spitter' | 'screamer';
export type DecorKind = 'campfire' | 'bench' | 'pump' | 'gate-bar' | 'cross';

/** Lo que un recinto pide colocar. Las etapas siguientes (props, barriles, encuentros) lo leen. */
export interface BlockSpots {
  cars: (Rect & { style: CarStyle })[];
  crates: { x: number; y: number; tier: CrateTier }[];
  barrels: { x: number; y: number }[];
  bodies: { x: number; y: number }[];
  zombies: { x: number; y: number; kind: SpotZombie; armored?: boolean }[];
  /** Solo decoración (el render la dibuja; la lógica no la ve). */
  decor: { kind: DecorKind; x: number; y: number; angle: number }[];
}

export function emptySpots(): BlockSpots {
  return { cars: [], crates: [], barrels: [], bodies: [], zombies: [], decor: [] };
}

/** Tipos que se arman como recinto (perímetro + una entrada). */
export const COMPOUND_KINDS: readonly BlockKind[] = ['park', 'parking', 'gas', 'construction', 'military', 'hospital'];

/**
 * Reparte los tipos entre las manzanas. Cada tipo especial tiene su "lugar lógico":
 *  - El retén militar, en la manzana más peligrosa (mejor loot, zombies duros: riesgo/recompensa).
 *  - El hospital, a media distancia.
 *  - Las casas, en las afueras; el centro queda con edificios altos.
 *  - Parques, estacionamientos, gasolineras y obras, donde caigan.
 */
export function assignBlockKinds(
  blocksX: number,
  blocksY: number,
  fixed: (bx: number, by: number) => BlockKind | null,
  dangerOf: (bx: number, by: number) => number,
  rng: Rng,
): BlockKind[] {
  const kinds: BlockKind[] = new Array(blocksX * blocksY).fill('buildings');
  const free: number[] = [];
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const k = fixed(bx, by);
      if (k) kinds[by * blocksX + bx] = k;
      else free.push(by * blocksX + bx);
    }
  }
  rng.shuffle(free);
  const danger = (i: number) => dangerOf(i % blocksX, Math.floor(i / blocksX));
  const take = (kind: BlockKind, pick: (candidates: number[]) => number | undefined) => {
    const i = pick(free);
    if (i === undefined) return;
    free.splice(free.indexOf(i), 1);
    kinds[i] = kind;
  };
  const best = (score: (i: number) => number) => (c: number[]) =>
    c.length ? c.reduce((a, b) => (score(b) > score(a) ? b : a)) : undefined;
  const first = (pred: (i: number) => boolean) => (c: number[]) => c.find(pred) ?? c[0];

  if (rng.chance(0.85)) take('military', best(danger));
  if (rng.chance(0.8)) take('hospital', first((i) => danger(i) > 0.3 && danger(i) < 0.8));
  for (let n = rng.int(1, 2); n > 0; n--) take('gas', first(() => true));
  for (let n = rng.int(2, 3); n > 0; n--) take('park', first(() => true));
  for (let n = rng.int(1, 2); n > 0; n--) take('parking', first(() => true));
  for (let n = rng.int(1, 2); n > 0; n--) take('construction', first(() => true));

  // Casas en las afueras: cuanto más lejos del centro, más probable.
  const cx = (blocksX - 1) / 2;
  const cy = (blocksY - 1) / 2;
  for (const i of [...free]) {
    const d = Math.hypot((i % blocksX) - cx, Math.floor(i / blocksX) - cy) / Math.hypot(cx, cy);
    if (d > 0.6 && rng.chance(0.25 + (d - 0.6) * 1.5)) kinds[i] = 'houses';
  }
  return kinds;
}

// ---------------------------------------------------------------------------------------------
// Recintos
// ---------------------------------------------------------------------------------------------

/** Lado del interior: 8 tiles (manzana de 12 menos 2 de vereda a cada lado). */
const N = 8;

/** Valores de la grilla local (se traducen a tiles reales al estampar). */
export const Local = {
  Floor: 0,
  Edge: 1, // perímetro (cerca, seto, muro o sacos, según el tipo)
  Wall: 2, // muro alto interior (la obra)
  Tree: 3,
  Building: 4,
  Solid: 5, // ocupado por un objeto (auto, caja, barril): piso para el render, sólido para el BFS
} as const;

interface LocalPlan {
  cells: Uint8Array;
  /** La entrada: columnas de la fila 0 que quedan abiertas. */
  gate: number[];
  buildings: (Rect & { floors: number; style: Building['style'] })[];
  spots: BlockSpots;
}

export interface CompoundResult {
  /** Grilla local ya orientada (N×N), con valores de Local. */
  cells: Uint8Array;
  buildings: Building[];
  spots: BlockSpots;
}

/**
 * Arma el interior de un recinto en `area` (el interior de la manzana, N×N).
 * `side`: 0 = entrada arriba, 1 = abajo, 2 = izquierda, 3 = derecha.
 */
export function buildCompound(kind: BlockKind, area: Rect, rng: Rng): CompoundResult {
  const side = rng.int(0, 3);
  // Entrada en el primer o el último tercio del lado (columnas 1-2 o 5-6), nunca en el medio.
  const gateStart = rng.chance(0.5) ? 1 : 5;
  const plan = planLocal(kind, gateStart, rng);

  // Transformación canónica → real. Las cuatro son biyecciones del cuadrado N×N que mandan la
  // fila 0 al lado elegido; cualquiera sirve porque el diseño no depende de izquierda/derecha.
  const map = (x: number, y: number): [number, number] => {
    if (side === 0) return [x, y];
    if (side === 1) return [x, N - 1 - y];
    if (side === 2) return [y, x];
    return [N - 1 - y, x];
  };
  const mapRect = (r: Rect): Rect => {
    const [ax, ay] = map(r.x, r.y);
    const [bx, by] = map(r.x + r.w - 1, r.y + r.h - 1);
    return { x: area.x + Math.min(ax, bx), y: area.y + Math.min(ay, by), w: Math.abs(bx - ax) + 1, h: Math.abs(by - ay) + 1 };
  };
  const mapPoint = (x: number, y: number) => {
    // Los puntos son centros con decimales: se transforma el tile y se conserva la fracción.
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const [mx, my] = map(tx, ty);
    const fx = x - tx;
    const fy = y - ty;
    const [ux, uy] = side === 0 ? [fx, fy] : side === 1 ? [fx, 1 - fy] : side === 2 ? [fy, fx] : [1 - fy, fx];
    return { x: area.x + mx + ux, y: area.y + my + uy };
  };
  const angleOffset = side === 0 ? 0 : side === 1 ? Math.PI : side === 2 ? -Math.PI / 2 : Math.PI / 2;

  const cells = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const [mx, my] = map(x, y);
    cells[my * N + mx] = plan.cells[y * N + x];
  }
  const s = plan.spots;
  const spots: BlockSpots = {
    cars: s.cars.map((c) => ({ ...mapRect(c), style: c.style })),
    crates: s.crates.map((c) => ({ ...mapRect({ x: c.x, y: c.y, w: 1, h: 1 }), tier: c.tier })).map((r) => ({ x: r.x, y: r.y, tier: r.tier })),
    barrels: s.barrels.map((b) => {
      const r = mapRect({ x: b.x, y: b.y, w: 1, h: 1 });
      return { x: r.x, y: r.y };
    }),
    bodies: s.bodies.map((b) => mapPoint(b.x, b.y)),
    zombies: s.zombies.map((z) => ({ ...z, ...mapPoint(z.x, z.y) })),
    decor: s.decor.map((d) => ({ kind: d.kind, ...mapPoint(d.x, d.y), angle: d.angle + angleOffset })),
  };
  const buildings: Building[] = plan.buildings.map((b) => ({ ...mapRect(b), floors: b.floors, style: b.style }));
  return { cells, buildings, spots };
}

/** Diseño canónico (entrada arriba, en las columnas gateStart y gateStart+1). */
function planLocal(kind: BlockKind, gateStart: number, rng: Rng): LocalPlan {
  const cells = new Uint8Array(N * N);
  const at = (x: number, y: number) => cells[y * N + x];
  const set = (x: number, y: number, v: number) => (cells[y * N + x] = v);
  const gateWidth = kind === 'construction' ? 1 : 2;
  const gate = Array.from({ length: gateWidth }, (_, i) => gateStart + i);
  const plan: LocalPlan = { cells, gate, buildings: [], spots: emptySpots() };

  // Perímetro con la entrada.
  for (let i = 0; i < N; i++) {
    set(i, 0, Local.Edge);
    set(i, N - 1, Local.Edge);
    set(0, i, Local.Edge);
    set(N - 1, i, Local.Edge);
  }
  for (const gx of gate) set(gx, 0, Local.Floor);
  // Los tiles justo detrás de la entrada nunca se ocupan: la puerta no puede quedar tapada.
  const reserved = new Set(gate.map((gx) => 1 * N + gx));
  const isFree = (x: number, y: number) => x > 0 && y > 0 && x < N - 1 && y < N - 1 && at(x, y) === Local.Floor && !reserved.has(y * N + x);

  /** ¿Se alcanza todo el piso desde la entrada? (BFS en 4 direcciones). */
  const allReachable = () => {
    const seen = new Uint8Array(N * N);
    const queue: number[] = [];
    for (const gx of gate) {
      seen[gx] = 1;
      queue.push(gx);
    }
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      const x = i % N;
      const y = Math.floor(i / N);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const j = ny * N + nx;
        if (seen[j] || cells[j] !== Local.Floor) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
    for (let i = 0; i < N * N; i++) if (cells[i] === Local.Floor && !seen[i]) return false;
    return true;
  };
  /** ¿El rectángulo toca algún piso por un costado? (si no, no se podría revisar). */
  const touchesFloor = (r: Rect) => {
    for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) {
      const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      const corner = (x < r.x || x >= r.x + r.w) && (y < r.y || y >= r.y + r.h);
      if (inside || corner || x < 0 || y < 0 || x >= N || y >= N) continue;
      if (at(x, y) === Local.Floor) return true;
    }
    return false;
  };
  /** Objetos que se revisan (autos, cajas): ninguno nuevo puede taparles el último acceso. */
  const accessible: Rect[] = [];
  /** Coloca un sólido a prueba: si encierra piso o deja algo inaccesible, se deshace. */
  const tryPlace = (r: Rect, value: number, needsAccess = true) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (!isFree(x, y)) return false;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) set(x, y, value);
    if (allReachable() && (!needsAccess || touchesFloor(r)) && accessible.every(touchesFloor)) {
      if (needsAccess) accessible.push(r);
      return true;
    }
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) set(x, y, Local.Floor);
    return false;
  };
  const randomCell = () => ({ x: rng.int(1, N - 2), y: rng.int(1, N - 2) });
  /** Tiles libres del interior, en orden al azar. */
  const freeCells = () => {
    const list: { x: number; y: number }[] = [];
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) if (isFree(x, y)) list.push({ x, y });
    return rng.shuffle(list);
  };
  /** Un punto de piso libre al azar (para cuerpos y zombies), o null. */
  const floorPoint = () => {
    const c = freeCells()[0];
    return c ? { x: c.x + 0.2 + rng.float() * 0.6, y: c.y + 0.2 + rng.float() * 0.6 } : null;
  };
  const addZombies = (count: number, kind: () => SpotZombie, armored = false) => {
    for (let n = 0; n < count; n++) {
      const p = floorPoint();
      if (p) plan.spots.zombies.push({ ...p, kind: kind(), armored });
    }
  };
  const crate = (tier: CrateTier) => {
    for (const c of freeCells()) {
      if (tryPlace({ x: c.x, y: c.y, w: 1, h: 1 }, Local.Solid)) {
        plan.spots.crates.push({ x: c.x, y: c.y, tier });
        return true;
      }
    }
    return false;
  };

  switch (kind) {
    case 'park': {
      // Árboles: tapan la vista (y las balas). Un parque es un lugar para perderse.
      for (let k = 0; k < 26; k++) {
        const c = randomCell();
        if (rng.chance(0.55)) tryPlace({ x: c.x, y: c.y, w: 1, h: 1 }, Local.Tree, false);
      }
      for (let n = rng.int(1, 2); n > 0; n--) {
        const p = floorPoint();
        if (p) plan.spots.decor.push({ kind: 'bench', ...p, angle: rng.chance(0.5) ? 0 : Math.PI / 2 });
      }
      // Campamento abandonado: fogata, un cuerpo y una caja. Rastro de supervivientes.
      if (rng.chance(0.4)) {
        const p = floorPoint();
        if (p) {
          plan.spots.decor.push({ kind: 'campfire', ...p, angle: 0 });
          crate('normal');
          const b = floorPoint();
          if (b) plan.spots.bodies.push(b);
        }
      } else if (rng.chance(0.5)) {
        const b = floorPoint();
        if (b) plan.spots.bodies.push(b);
      }
      addZombies(rng.int(1, 3), () => 'walker');
      break;
    }
    case 'parking': {
      // Autos en fila. Muchos con alarma: tentador, y ruidoso.
      for (let k = 0; k < 40 && plan.spots.cars.length < 4; k++) {
        const c = randomCell();
        const r = rng.chance(0.5) ? { x: c.x, y: c.y, w: 3, h: 2 } : { x: c.x, y: c.y, w: 2, h: 3 };
        if (tryPlace(r, Local.Solid)) plan.spots.cars.push({ ...r, style: 'parked' });
      }
      if (rng.chance(0.4)) {
        const b = floorPoint();
        if (b) plan.spots.bodies.push(b);
      }
      addZombies(rng.int(1, 2), () => 'walker');
      break;
    }
    case 'gas': {
      // La tienda al fondo y los surtidores (barriles explosivos) en el medio.
      const left = rng.chance(0.5);
      const shop = { x: left ? 0 : 4, y: 5, w: 4, h: 3 };
      for (let y = shop.y; y < shop.y + shop.h; y++) for (let x = shop.x; x < shop.x + shop.w; x++) set(x, y, Local.Building);
      plan.buildings.push({ ...shop, floors: 1, style: 'shop' });
      for (const px of [2, 5]) {
        if (tryPlace({ x: px, y: 3, w: 1, h: 1 }, Local.Solid, false)) {
          plan.spots.barrels.push({ x: px, y: 3 });
          plan.spots.decor.push({ kind: 'pump', x: px + 0.5, y: 2.5, angle: 0 });
        }
      }
      for (let k = 0; k < 10 && plan.spots.barrels.length < 4; k++) {
        const c = randomCell();
        if (tryPlace({ x: c.x, y: c.y, w: 1, h: 1 }, Local.Solid, false)) plan.spots.barrels.push(c);
      }
      crate('normal');
      addZombies(rng.int(2, 3), () => (rng.chance(0.2) ? 'bloater' : 'walker'));
      break;
    }
    case 'construction': {
      // Laberinto de pasillos de un tile entre muros altos. Celdas en las coordenadas impares
      // (1, 3, 5), muros en las pares. Se cava con "backtracking recursivo": desde una celda se
      // avanza a un vecino sin visitar, tumbando el muro del medio, hasta que no quedan vecinos;
      // entonces se retrocede. Da un laberinto perfecto (un solo camino entre dos celdas).
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) set(x, y, Local.Wall);
      const cellsXY = [1, 3, 5];
      const visited = new Set<string>();
      const stack: [number, number][] = [[gateStart, 1]];
      set(gateStart, 1, Local.Floor);
      visited.add(`${gateStart},1`);
      while (stack.length) {
        const [cx, cy] = stack[stack.length - 1];
        const options = (
          [[2, 0], [-2, 0], [0, 2], [0, -2]] as const
        ).filter(([dx, dy]) => cellsXY.includes(cx + dx) && cellsXY.includes(cy + dy) && !visited.has(`${cx + dx},${cy + dy}`));
        if (!options.length) {
          stack.pop();
          continue;
        }
        const [dx, dy] = rng.pick(options);
        set(cx + dx / 2, cy + dy / 2, Local.Floor);
        set(cx + dx, cy + dy, Local.Floor);
        visited.add(`${cx + dx},${cy + dy}`);
        stack.push([cx + dx, cy + dy]);
      }
      // Un muro extra tumbado: un pequeño circuito para poder dar la vuelta a un zombie.
      for (let k = 0; k < 20; k++) {
        const x = rng.pick([2, 4]);
        const y = rng.pick([1, 3, 5]);
        const [wx, wy] = rng.chance(0.5) ? [x, y] : [y, x];
        if (at(wx, wy) === Local.Wall) {
          set(wx, wy, Local.Floor);
          break;
        }
      }
      // Cajas en los callejones sin salida: el premio está al fondo.
      const deadEnds: [number, number][] = [];
      for (const y of cellsXY) for (const x of cellsXY) {
        if (x === gateStart && y === 1) continue;
        const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => at(x + dx, y + dy) === Local.Floor).length;
        if (open === 1) deadEnds.push([x, y]);
      }
      for (const [x, y] of rng.shuffle(deadEnds).slice(0, 2)) {
        set(x, y, Local.Solid);
        plan.spots.crates.push({ x, y, tier: 'normal' });
      }
      addZombies(rng.int(2, 3), () => 'walker');
      break;
    }
    case 'military': {
      // Retén: sacos de arena, carpas, un camión y cajas militares. Zombies con blindaje.
      const tents = [
        { x: 1, y: 4, w: 3, h: 2 },
        { x: 5, y: 4, w: 2, h: 3 },
      ];
      for (const t of tents) {
        if (tryPlace(t, Local.Building, false)) plan.buildings.push({ ...t, floors: 1, style: 'tent' });
      }
      for (let k = 0; k < 30 && !plan.spots.cars.length; k++) {
        const c = randomCell();
        const r = { x: c.x, y: c.y, w: 3, h: 2 };
        if (tryPlace(r, Local.Solid)) plan.spots.cars.push({ ...r, style: 'military' });
      }
      for (let n = 0; n < 3; n++) crate('military');
      plan.spots.decor.push({ kind: 'gate-bar', x: gateStart + 1, y: 0.5, angle: 0 });
      addZombies(rng.int(4, 6), () => (rng.chance(0.35) ? 'runner' : 'walker'), true);
      break;
    }
    case 'hospital': {
      // El edificio ocupa el fondo; adelante, una franja con la ambulancia.
      for (let y = 3; y < N; y++) for (let x = 0; x < N; x++) set(x, y, Local.Building);
      plan.buildings.push({ x: 0, y: 3, w: N, h: N - 3, floors: 4, style: 'hospital' });
      plan.spots.decor.push({ kind: 'cross', x: N / 2, y: 3 + (N - 3) / 2, angle: 0 });
      const ambX = gateStart === 1 ? 4 : 1;
      if (tryPlace({ x: ambX, y: 1, w: 3, h: 2 }, Local.Solid)) plan.spots.cars.push({ x: ambX, y: 1, w: 3, h: 2, style: 'ambulance' });
      crate('medical');
      // Un especial cuida la puerta del hospital.
      addZombies(1, () => (rng.chance(0.5) ? 'bloater' : 'spitter'));
      addZombies(2, () => 'walker');
      break;
    }
  }
  return plan;
}
