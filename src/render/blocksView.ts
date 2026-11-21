// Dibuja lo que hay en las manzanas especiales y en las calles cortadas: pisos de los recintos,
// agua y puentes del canal, cercas, muros, árboles, techos de las casas, decoración y las
// barricadas según su estilo (bus volcado, escombros, choque, vallas de policía).
//
// Rendimiento: todo lo que es "una caja de algún color" va a UNA sola InstancedMesh de piezas
// (PieceBatch): cada pieza es una instancia con su matriz (posición, giro, tamaño) y su color.
// Cientos de bancos, sacos de arena, autos chocados y trozos de escombro cuestan una sola llamada
// de dibujo. Los árboles van aparte porque usan otras geometrías (tronco y copa).

import * as THREE from 'three';
import type { City } from '../world/city';
import { Rng } from '../world/rng';
import { BLOCK_SIZE, buildingHeight, SIDEWALK_WIDTH, Tile, type BarricadeStyle, type Rect } from '../world/tileGrid';
import type { BlockKind } from '../world/blocks';

const FLOOR_COLOR: Partial<Record<BlockKind, number>> = {
  park: 0x2b4226,
  parking: 0x33363b,
  gas: 0x3a3b40,
  construction: 0x4d4233,
  military: 0x3e412f,
  hospital: 0x45484d,
};
const CAR_COLORS = [0x7a2e2e, 0x2e4a7a, 0x8a8a8a, 0x2f2f33, 0x6b6b3a, 0xcfcfcf];
const ROOF_COLORS = [0x6e2f26, 0x5a3a2a, 0x3f3f46, 0x7a4a2a, 0x4a2f2f];

/** Acumula cajas (posición de la base, tamaño, giro y color) y las vuelca en una InstancedMesh. */
class PieceBatch {
  private readonly items: { x: number; y: number; z: number; sx: number; sy: number; sz: number; rot: number; color: number }[] = [];

  /** (x, z) es el centro en el piso; y es la altura de la base. */
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, rot: number, color: number): void {
    this.items.push({ x, y, z, sx, sy, sz, rot, color });
  }

  build(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, this.items.length));
    mesh.count = this.items.length;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    this.items.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rot);
      m.compose(pos.set(p.x, p.y, p.z), q, scale.set(p.sx, p.sy, p.sz));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color.setHex(p.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }
}

export interface BlocksView {
  root: THREE.Group;
  /** Fogatas y autos en llamas que titilan, humo que sube. (x, y): el jugador, para la luz del fuego. */
  update(time: number, x?: number, y?: number): void;
}

const SMOKE_PER_FIRE = 12;
const FLAMES_PER_CAR = 4;
/** La luz del fuego (una sola, va al auto en llamas más cercano al jugador). */
const FIRE_LIGHT_RANGE = 40;

export function buildBlocksView(city: City): BlocksView {
  const root = new THREE.Group();
  const { grid } = city;
  const rng = new Rng(city.seed).fork('blocks-view');
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0); // base en y = 0
  const pieces = new PieceBatch();
  const flatPieces = new PieceBatch(); // pisos y agua: no proyectan sombra

  // ¿A qué manzana pertenece un tile? (para saber de qué tipo es la cerca)
  const blockOf = (x: number, y: number) =>
    grid.blocks.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);

  // 1. Pisos de los recintos.
  for (const b of grid.blocks) {
    const color = FLOOR_COLOR[b.kind];
    if (color === undefined) continue;
    const inner = SIDEWALK_WIDTH;
    flatPieces.add(b.x + BLOCK_SIZE / 2, 0, b.y + BLOCK_SIZE / 2, BLOCK_SIZE - inner * 2, 0.17, BLOCK_SIZE - inner * 2, 0, color);
    // Estacionamiento: líneas pintadas.
    if (b.kind === 'parking') {
      for (let k = 1; k < 7; k += 2) flatPieces.add(b.x + inner + 0.5 + k, 0.17, b.y + BLOCK_SIZE / 2, 0.08, 0.01, 6, 0, 0xb8b8a0);
    }
  }

  // 2. Agua y puentes.
  const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x0f2533, roughness: 0.12, metalness: 0.55 });
  for (const r of grid.water) {
    const water = new THREE.Mesh(box, waterMaterial);
    water.scale.set(r.w, 0.04, r.h);
    water.position.set(r.x + r.w / 2, 0, r.y + r.h / 2);
    water.receiveShadow = true;
    root.add(water);
  }
  for (const r of grid.bridges) {
    // El puente cruza en x: tablero un poco más claro y barandas a los dos lados.
    flatPieces.add(r.x + r.w / 2, 0, r.y + r.h / 2, r.w, 0.05, r.h + 0.6, 0, 0x50545b);
    for (const side of [r.y - 0.15, r.y + r.h + 0.15]) {
      pieces.add(r.x + r.w / 2, 0, side, r.w, 0.9, 0.18, 0, 0x6d737b);
      for (let k = 0; k <= r.w; k += 2) pieces.add(r.x + k, 0, side, 0.22, 1.0, 0.25, 0, 0x5a5f66);
    }
  }

  // 3. Cercas, setos, muros, sacos y árboles (tile por tile).
  const trunks: THREE.Matrix4[] = [];
  const canopies: { m: THREE.Matrix4; color: number }[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const tile = grid.tiles[y * grid.width + x];
      const cx = x + 0.5;
      const cz = y + 0.5;
      if (tile === Tile.Fence) {
        const block = blockOf(x, y);
        if (block?.kind === 'park') {
          pieces.add(cx, 0, cz, 1, 0.95, 1, 0, 0x2c4f2c); // seto
          continue;
        }
        // Reja: un panel delgado orientado según el lado del recinto (las esquinas llevan dos).
        // (La valla militar de la plaza va por el borde de la manzana, no del recinto: finale.ts.)
        const plaza = block?.isPlaza === true;
        const inset = plaza ? 0 : SIDEWALK_WIDTH;
        const lx = block ? x - block.x - inset : 1;
        const ly = block ? y - block.y - inset : 1;
        const edge = BLOCK_SIZE - inset * 2 - 1;
        const color = plaza ? 0x5d6644 : block?.kind === 'hospital' ? 0xb0b6bc : 0x7c838b;
        if (ly === 0 || ly === edge) pieces.add(cx, 0, cz, 1, 1.3, 0.08, 0, color);
        if (lx === 0 || lx === edge) pieces.add(cx, 0, cz, 0.08, 1.3, 1, 0, color);
        pieces.add(x, 0, cz, 0.1, 1.45, 0.1, 0, 0x50555c); // poste
      } else if (tile === Tile.Sandbag) {
        pieces.add(cx, 0, cz, 1, 0.45, 0.85, 0, 0x7a6e4c);
        pieces.add(cx, 0.45, cz, 0.9, 0.4, 0.75, (x + y) % 2 ? 0.05 : -0.05, 0x847856);
      } else if (tile === Tile.Wall) {
        // Muro de obra: tablones con una franja de seguridad.
        pieces.add(cx, 0, cz, 1, 2.6, 1, 0, (x + y) % 2 ? 0x86683d : 0x7d6139);
        pieces.add(cx, 2.1, cz, 1.02, 0.18, 1.02, 0, 0xd9a92b);
      } else if (tile === Tile.Tree) {
        const s = 0.85 + rng.float() * 0.45;
        trunks.push(new THREE.Matrix4().compose(new THREE.Vector3(cx, 0, cz), new THREE.Quaternion(), new THREE.Vector3(1, 1 + s * 0.4, 1)));
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.float() * Math.PI);
        canopies.push({
          m: new THREE.Matrix4().compose(new THREE.Vector3(cx + (rng.float() - 0.5) * 0.3, 2.2 + s * 0.6, cz + (rng.float() - 0.5) * 0.3), q, new THREE.Vector3(s, s * 0.9, s)),
          color: rng.pick([0x253f22, 0x2e4a26, 0x1f3a24, 0x34502a]),
        });
      }
    }
  }
  if (trunks.length) {
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1.8, 6);
    trunkGeo.translate(0, 0.9, 0);
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 }), trunks.length);
    trunks.forEach((m, i) => trunkMesh.setMatrixAt(i, m));
    trunkMesh.castShadow = true;
    root.add(trunkMesh);
    // Copa: un icosaedro sin subdividir (facetado, combina con el estilo de cajas).
    const canopyMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1.25, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
      canopies.length,
    );
    const color = new THREE.Color();
    canopies.forEach((c, i) => {
      canopyMesh.setMatrixAt(i, c.m);
      canopyMesh.setColorAt(i, color.setHex(c.color));
    });
    canopyMesh.castShadow = true;
    canopyMesh.receiveShadow = true;
    root.add(canopyMesh);
  }

  // 4. Techos a cuatro aguas de las casas: una pirámide de base cuadrada (cono de 4 lados
  //    girado 45°) estirada al tamaño de cada casa.
  const houses = grid.buildings.filter((b) => b.style === 'house');
  if (houses.length) {
    const roofGeo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
    roofGeo.rotateY(Math.PI / 4);
    roofGeo.translate(0, 0.5, 0);
    const roofs = new THREE.InstancedMesh(roofGeo, new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }), houses.length);
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    houses.forEach((b, i) => {
      m.makeScale(b.w - 0.1, 1.5, b.h - 0.1);
      m.setPosition(b.x + b.w / 2, buildingHeight(b), b.y + b.h / 2);
      roofs.setMatrixAt(i, m);
      roofs.setColorAt(i, color.setHex(rng.pick(ROOF_COLORS)));
    });
    roofs.castShadow = true;
    root.add(roofs);
  }

  // 5. Decoración de los recintos.
  const fires: { glow: THREE.Mesh; x: number; z: number; phase: number }[] = [];
  const glowMaterial = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const glowGeo = new THREE.CircleGeometry(1, 24);
  glowGeo.rotateX(-Math.PI / 2);
  for (const b of grid.blocks) {
    for (const d of b.spots.decor) {
      const { x, y: z, angle } = d;
      if (d.kind === 'bench') {
        pieces.add(x, 0.35, z, 1.3, 0.08, 0.45, angle, 0x6a4a2e);
        pieces.add(x, 0, z, 1.2, 0.35, 0.1, angle, 0x2d2d30);
      } else if (d.kind === 'pump') {
        pieces.add(x, 0, z, 0.55, 1.4, 0.35, 0, 0xb83a2e);
        pieces.add(x, 1.0, z + 0.18, 0.4, 0.25, 0.02, 0, 0xdde6ee);
      } else if (d.kind === 'gate-bar') {
        pieces.add(x, 0.95, z, 2.2, 0.1, 0.1, angle, 0xd23b2b);
        pieces.add(x - Math.cos(angle) * 1.1, 0, z - Math.sin(angle) * 1.1, 0.2, 1.05, 0.2, 0, 0x3b3b3b);
      } else if (d.kind === 'cross') {
        const hospital = grid.buildings.find((h) => h.style === 'hospital' && x >= h.x && x <= h.x + h.w && z >= h.y && z <= h.y + h.h);
        const top = hospital ? buildingHeight(hospital) : 12;
        pieces.add(x, top, z, 3, 0.06, 0.9, 0, 0xc0262a);
        pieces.add(x, top, z, 0.9, 0.06, 3, 0, 0xc0262a);
      } else if (d.kind === 'campfire') {
        for (let k = 0; k < 3; k++) pieces.add(x, 0, z, 0.9, 0.14, 0.16, (k * Math.PI) / 3, 0x3a2618);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          pieces.add(x + Math.cos(a) * 0.55, 0, z + Math.sin(a) * 0.55, 0.22, 0.16, 0.22, a, 0x55565a);
        }
        const glow = new THREE.Mesh(glowGeo, glowMaterial);
        glow.position.set(x, 0.2, z);
        glow.scale.setScalar(1.6);
        root.add(glow);
        fires.push({ glow, x, z, phase: rng.float() * 10 });
      }
    }
  }

  // 6. Barricadas según su estilo.
  for (const r of grid.barricades) addBarricade(pieces, r, r.style, r.dir, rng);

  const material = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  const piecesMesh = pieces.build(box, material);
  piecesMesh.castShadow = true;
  piecesMesh.receiveShadow = true;
  root.add(piecesMesh);
  const floors = flatPieces.build(box, new THREE.MeshStandardMaterial({ roughness: 0.95 }));
  floors.receiveShadow = true;
  root.add(floors);

  // 7. Flechas de supervivientes: pintadas en la calle, apuntando hacia la salida más cercana.
  if (city.decor.graffiti.length) {
    const arrow = new THREE.Shape();
    // Flecha apuntando a +x en el plano del dibujo (cola, cuerpo y punta).
    arrow.moveTo(-1.3, -0.22);
    arrow.lineTo(0.3, -0.22);
    arrow.lineTo(0.3, -0.6);
    arrow.lineTo(1.3, 0);
    arrow.lineTo(0.3, 0.6);
    arrow.lineTo(0.3, 0.22);
    arrow.lineTo(-1.3, 0.22);
    const arrowGeo = new THREE.ShapeGeometry(arrow);
    arrowGeo.rotateX(-Math.PI / 2);
    const arrows = new THREE.InstancedMesh(
      arrowGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }),
      city.decor.graffiti.length,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    city.decor.graffiti.forEach((g, i) => {
      // Girar en Y por -ángulo lleva el +x de la flecha a la dirección (cos, sin) de la grilla (x, z).
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -g.angle);
      m.compose(new THREE.Vector3(g.x, 0.03, g.y), q, new THREE.Vector3(1.2, 1, 1.2));
      arrows.setMatrixAt(i, m);
      arrows.setColorAt(i, color.setHex(g.color));
    });
    arrows.receiveShadow = true;
    root.add(arrows);
  }

  // 8. Basura en las veredas (bolsas y cajas aplastadas).
  if (city.decor.trash.length) {
    const trash = new PieceBatch();
    for (const t of city.decor.trash) trash.add(t.x, 0.15, t.y, t.size * 1.4, t.size * 0.6, t.size, t.angle, t.color);
    const trashMesh = trash.build(box, new THREE.MeshStandardMaterial({ roughness: 0.9 }));
    trashMesh.receiveShadow = true;
    root.add(trashMesh);
  }

  // 9. Autos en llamas: llamas (conos que titilan), resplandor en el piso y una columna de humo.
  //    El humo no guarda estado: la fase de cada bocanada sale del tiempo, así sube y se repite sola.
  const burning = city.decor.burning;
  const flameGeo = new THREE.ConeGeometry(0.35, 1, 6);
  flameGeo.translate(0, 0.5, 0);
  const flames = new THREE.InstancedMesh(
    flameGeo,
    new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    Math.max(1, burning.length * FLAMES_PER_CAR),
  );
  flames.count = burning.length * FLAMES_PER_CAR;
  const smoke = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshBasicMaterial({ color: 0x262626, transparent: true, opacity: 0.45, depthWrite: false }),
    Math.max(1, burning.length * SMOKE_PER_FIRE),
  );
  smoke.count = burning.length * SMOKE_PER_FIRE;
  // Las instancias se mueven cada cuadro: sin esto, three.js las recorta con la esfera inicial.
  flames.frustumCulled = false;
  smoke.frustumCulled = false;
  const fireGlows: THREE.Mesh[] = [];
  const fireGlowMaterial = glowMaterial.clone();
  fireGlowMaterial.color.setHex(0xff5a14);
  for (const b of burning) {
    const glow = new THREE.Mesh(glowGeo, fireGlowMaterial);
    glow.position.set(b.x, 0.05, b.y);
    glow.scale.setScalar(3.5);
    root.add(glow);
    fireGlows.push(glow);
  }
  // Las llamas salen de distintos puntos del auto (offsets fijos por seed).
  const flameSpots = burning.flatMap(() =>
    Array.from({ length: FLAMES_PER_CAR }, () => ({ dx: (rng.float() - 0.5) * 1.8, dz: (rng.float() - 0.5) * 0.9, phase: rng.float() * 10 })),
  );
  const fireLight = new THREE.PointLight(0xff7a2a, 0, 13, 1.4);
  fireLight.position.y = 2.2;
  if (burning.length) root.add(fireLight, flames, smoke);
  const fm = new THREE.Matrix4();
  const fq = new THREE.Quaternion();
  const fpos = new THREE.Vector3();
  const fscale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    root,
    update(time: number, px?: number, py?: number) {
      for (const f of fires) {
        // Dos senos de frecuencias que no encajan: titila sin repetirse a simple vista.
        const flicker = 0.75 + 0.15 * Math.sin(time * 9 + f.phase) + 0.1 * Math.sin(time * 23.7 + f.phase * 2);
        f.glow.scale.setScalar(1.4 + flicker * 0.5);
      }
      if (!burning.length) return;
      let nearest = -1;
      let best = FIRE_LIGHT_RANGE;
      burning.forEach((car, i) => {
        fireGlows[i].scale.setScalar(3.2 + 0.5 * Math.sin(time * 7 + i) + 0.3 * Math.sin(time * 19 + i * 3));
        for (let k = 0; k < FLAMES_PER_CAR; k++) {
          const s = flameSpots[i * FLAMES_PER_CAR + k];
          const h = 0.9 + 0.5 * Math.sin(time * 11 + s.phase) + 0.3 * Math.sin(time * 27 + s.phase);
          fm.compose(fpos.set(car.x + s.dx, 0.8, car.y + s.dz), fq.identity(), fscale.set(1, Math.max(0.3, h), 1));
          flames.setMatrixAt(i * FLAMES_PER_CAR + k, fm);
        }
        for (let k = 0; k < SMOKE_PER_FIRE; k++) {
          // Fase 0→1: la bocanada nace sobre el auto, sube, crece y se ladea con el "viento".
          const p = (time * 0.18 + k / SMOKE_PER_FIRE + i * 0.37) % 1;
          const size = 0.5 + p * 2.2;
          fm.compose(
            fpos.set(car.x + p * 3.5 + Math.sin(k * 7.1) * 0.4, 1.4 + p * 9, car.y - p * 2 + Math.cos(k * 3.3) * 0.4),
            fq.setFromAxisAngle(up, k + time * 0.3),
            fscale.set(size, size * 0.8, size),
          );
          smoke.setMatrixAt(i * SMOKE_PER_FIRE + k, fm);
        }
        if (px !== undefined && py !== undefined) {
          const d = Math.hypot(car.x - px, car.y - py);
          if (d < best) {
            best = d;
            nearest = i;
          }
        }
      });
      flames.instanceMatrix.needsUpdate = true;
      smoke.instanceMatrix.needsUpdate = true;
      if (nearest >= 0) {
        fireLight.position.x = burning[nearest].x;
        fireLight.position.z = burning[nearest].y;
        fireLight.intensity = 9 + 2.5 * Math.sin(time * 13) + 1.5 * Math.sin(time * 31);
      } else fireLight.intensity = 0;
    },
  };
}

/**
 * Una barricada ocupa un rectángulo largo (12 tiles a lo ancho de la calle) y angosto (2).
 * `dir` es la dirección del tramo cortado: 'h' = la calle va en x, la barricada se extiende en z.
 */
function addBarricade(pieces: PieceBatch, r: Rect, style: BarricadeStyle, dir: 'h' | 'v', rng: Rng): void {
  const cx = r.x + r.w / 2;
  const cz = r.y + r.h / 2;
  const length = dir === 'h' ? r.h : r.w;
  // Ángulo de la barricada: se extiende a lo largo de z si el tramo era horizontal.
  const rot = dir === 'h' ? Math.PI / 2 : 0;
  const along = (t: number) => (dir === 'h' ? { x: cx, z: r.y + t } : { x: r.x + t, z: cz });

  switch (style) {
    case 'barrier': {
      // La de siempre: tablones naranjas con franjas blancas.
      pieces.add(cx, 0, cz, r.w - 0.1, 1.4, r.h - 0.1, 0, 0xd9822b);
      for (let t = 1.5; t < length; t += 3) {
        const p = along(t);
        pieces.add(p.x, 0.9, p.z, 1.2, 0.25, (dir === 'h' ? r.w : r.h) - 0.06, rot, 0xeeeeee);
      }
      break;
    }
    case 'bus': {
      // Bus atravesado: el largo del bus es el ancho de la calle.
      const p = along(length / 2);
      pieces.add(p.x, 0.25, p.z, length - 0.4, 1.7, 1.9, rot, 0xc99a22);
      pieces.add(p.x, 1.05, p.z, length - 1.2, 0.55, 1.94, rot, 0x1d2329); // ventanas
      pieces.add(p.x, 1.95, p.z, length - 0.6, 0.08, 1.7, rot, 0xb38818); // techo
      for (const t of [2.2, length - 2.2]) {
        const w = along(t);
        pieces.add(w.x, 0, w.z, 0.6, 0.55, 2.0, rot, 0x1a1a1a); // ruedas
      }
      break;
    }
    case 'rubble': {
      // Escombros: trozos de concreto de distintos tamaños, girados al azar.
      for (let t = 0.5; t < length; t += 0.8 + rng.float() * 0.6) {
        const p = along(t);
        const s = 0.6 + rng.float() * 1.0;
        const off = (rng.float() - 0.5) * 0.9;
        pieces.add(p.x + (dir === 'v' ? 0 : off), 0, p.z + (dir === 'h' ? 0 : off), s * 1.2, 0.4 + rng.float() * 1.1, s, rng.float() * Math.PI, rng.pick([0x6d6a66, 0x5d5a57, 0x7d7873, 0x4f4c49]));
      }
      for (let k = 0; k < 4; k++) {
        const p = along(rng.float() * length);
        pieces.add(p.x, 0.6 + rng.float() * 0.5, p.z, 0.08, 0.08, 1.6, rng.float() * Math.PI, 0x8a4a2a); // fierros
      }
      break;
    }
    case 'crash': {
      // Choque en cadena: autos cruzados en distintos ángulos.
      for (let t = 1.8; t < length - 1; t += 3.3) {
        const p = along(t + (rng.float() - 0.5) * 0.6);
        const yaw = rot + (rng.float() - 0.5) * 0.9;
        const color = rng.pick(CAR_COLORS);
        pieces.add(p.x, 0.15, p.z, 3.2, 0.75, 1.6, yaw, color);
        pieces.add(p.x, 0.9, p.z, 1.7, 0.5, 1.45, yaw, 0x1b222b);
      }
      break;
    }
    case 'police': {
      // Vallas de policía: caballetes azul y blanco, en dos filas.
      for (let t = 1; t < length; t += 2) {
        const p = along(t);
        for (const off of [-0.45, 0.45]) {
          const ox = dir === 'h' ? off : 0;
          const oz = dir === 'v' ? off : 0;
          pieces.add(p.x + ox, 0.75, p.z + oz, 1.9, 0.32, 0.08, rot, (Math.round(t) / 2) % 2 ? 0x2a4fa0 : 0xe8e8e8);
          pieces.add(p.x + ox, 0, p.z + oz, 0.1, 1.15, 0.1, rot, 0x3a3a3a);
        }
      }
      break;
    }
  }
}
