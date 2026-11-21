// Dibujo de los zombies y sus cadáveres con InstancedMesh.
//
// Cientos de zombies en UNA llamada de dibujo: la GPU recibe una sola geometría (cuerpo + brazos
// estirados hacia adelante) y una matriz y un color por zombie. En cada cuadro solo reescribimos
// esas matrices, que es muy barato.
//
// Qué zombies se dibujan: solo los que el jugador podría ver, es decir, con línea de visión libre
// desde el jugador (los edificios tapan). Con la cámara desde arriba veríamos por encima de los
// techos lo que hay en la calle de al lado; esto lo evita y mantiene el "no sé qué hay a la vuelta".
// Dentro de lo visible, la iluminación hace el resto: en la oscuridad apenas se distinguen.
//
// Los zombies comunes se dibujan en TRES mallas instanciadas que comparten la matriz: cuerpo,
// brazo izquierdo y brazo derecho. Así un brazo cortado es solo "no dibujar esa instancia" (una
// matriz de escala cero), sin geometrías distintas por zombie. Sin piernas se dibuja tumbado
// hacia adelante, arrastrándose. El tanque, que nunca pierde miembros, sigue en una sola malla.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LIMB_ARM_L, LIMB_ARM_R, LIMB_LEGS, type GameState, type Zombie } from '../game/state';
import { lineOfSight } from '../game/visibility';
import type { TileGrid } from '../world/tileGrid';
import { BUILDING_STENCIL } from './cityRenderer';

/** Escala [ancho, alto] de cada tipo sobre la malla del caminante (el tanque tiene la suya). */
const SHAPES: Record<Zombie['kind'], [number, number]> = {
  walker: [1, 1],
  runner: [0.85, 0.95],
  bloater: [1.65, 0.95],
  screamer: [0.9, 1.12],
  spitter: [0.95, 0.92],
  tank: [1, 1],
  // La sonámbula: alta y flaca.
  sleeper: [0.78, 1.18],
};
const BURN_COLOR = new THREE.Color(0xff6a1a);
/** Inclinación del que se arrastra (radianes hacia adelante). */
const CRAWL_TILT = -1.25;

const MAX_WALKERS = 600;
const MAX_TANKS = 8;
const MAX_CORPSES = 300;
/** Más lejos que esto ni siquiera se prueba la línea de visión (queda fuera de pantalla). */
const DRAW_DISTANCE = 34;
/** Hasta dónde se ve la silueta de un zombie tapado por un edificio. */
const GHOST_DISTANCE = 20;

function zombieParts(radius: number, height: number, armLength: number) {
  const body = new THREE.CapsuleGeometry(radius, height - radius * 2, 4, 10);
  body.translate(0, height / 2, 0);
  // Brazos: dos cajas que salen hacia +x (el frente), a la altura de los hombros.
  // En Three.js el lado izquierdo del zombie (mirando a +x) es -z.
  const armL = new THREE.BoxGeometry(armLength, radius * 0.35, radius * 0.35);
  armL.translate(radius * 0.5 + armLength / 2, height * 0.72, -radius * 0.55);
  const armR = armL.clone();
  armR.translate(0, 0, radius * 1.1);
  const merged = mergeGeometries([body.toNonIndexed(), armL.toNonIndexed(), armR.toNonIndexed()]) ?? body;
  return { body, armL, armR, merged };
}

/**
 * El tanque: un simio deforme. Torso encorvado hacia adelante, cabeza chica hundida entre los
 * hombros, brazos enormes que llegan al suelo (camina apoyando los puños), piernas cortas y
 * bultos en la espalda. Todo en una sola geometría para dibujarlo con un InstancedMesh.
 * El frente es +x, como en zombieParts.
 */
function tankParts(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, rz = 0, rx = 0) => {
    g.rotateX(rx);
    g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  add(new THREE.CapsuleGeometry(0.85, 0.9, 4, 12), 0.05, 1.6, 0, -0.45); // torso encorvado
  add(new THREE.SphereGeometry(0.3, 10, 8), 0.85, 2.05, 0); // cabeza hundida
  add(new THREE.BoxGeometry(0.42, 0.18, 0.4), 1.05, 1.9, 0); // mandíbula
  for (const side of [-1, 1]) {
    add(new THREE.SphereGeometry(0.55, 10, 8), 0.35, 2.3, side * 0.95); // hombro
    add(new THREE.CapsuleGeometry(0.33, 1.3, 4, 8), 0.65, 1.3, side * 1.1, 0.35, side * 0.12); // brazo
    add(new THREE.BoxGeometry(0.75, 0.55, 0.7), 0.95, 0.3, side * 1.15); // puño en el suelo
    add(new THREE.CapsuleGeometry(0.28, 0.5, 4, 8), -0.35, 0.45, side * 0.45); // pierna corta
  }
  // Bultos (tumores) asimétricos en la espalda.
  add(new THREE.SphereGeometry(0.4, 8, 6), -0.55, 2.3, 0.3);
  add(new THREE.SphereGeometry(0.3, 8, 6), -0.7, 1.85, -0.45);
  add(new THREE.SphereGeometry(0.22, 8, 6), -0.3, 2.65, -0.25);
  return mergeGeometries(parts) ?? parts[0];
}

export class ZombieView {
  readonly root = new THREE.Group();
  private readonly walkers: THREE.InstancedMesh;
  private readonly armsL: THREE.InstancedMesh;
  private readonly armsR: THREE.InstancedMesh;
  private readonly tanks: THREE.InstancedMesh;
  private readonly corpses: THREE.InstancedMesh;
  /** Copias de los zombies que solo se dibujan donde algo los TAPA (ver constructor). */
  private readonly walkerGhosts: THREE.InstancedMesh;
  private readonly tankGhosts: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly side = new THREE.Vector3(0, 0, 1);
  private readonly tumble = new THREE.Quaternion();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private time = 0;
  private readonly color = new THREE.Color();
  /** Versión de los cadáveres ya dibujada (usamos el total de muertes, que solo crece). */
  private corpseVersion = -1;

  constructor() {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const walker = zombieParts(0.33, 1.55, 0.55);
    this.walkers = new THREE.InstancedMesh(walker.body, material, MAX_WALKERS);
    this.armsL = new THREE.InstancedMesh(walker.armL, material, MAX_WALKERS);
    this.armsR = new THREE.InstancedMesh(walker.armR, material, MAX_WALKERS);
    this.tanks = new THREE.InstancedMesh(tankParts(), material.clone(), MAX_TANKS);
    for (const mesh of [this.walkers, this.armsL, this.armsR, this.tanks]) {
      mesh.castShadow = true;
      mesh.count = 0;
      // Las instancias se mueven por todo el mapa: el "bounding sphere" de la malla original no
      // sirve para descartar lo que está fuera de cámara, así que desactivamos ese descarte.
      mesh.frustumCulled = false;
      // Inicializa el buffer de colores por instancia.
      mesh.setColorAt(0, this.color.setHex(0xffffff));
    }

    // Siluetas a través de los edificios. Con la cámara en diagonal, un edificio puede tapar
    // a un zombie que el jugador SÍ tiene a la vista (están en la misma calle, pero el bloque
    // queda entre él y la cámara). Truco: dibujamos cada zombie otra vez con depthFunc =
    // GreaterDepth, es decir, "píntate solo donde haya algo MÁS CERCA de la cámara que tú".
    // Donde el zombie se ve normal, esa prueba falla y no se dibuja nada extra; donde lo tapa
    // una pared, aparece su silueta roja sobre la pared.
    // Con eso solo, el propio cuerpo del zombie "tapa" sus brazos y los teñiría de rojo. Por eso
    // además se exige que el píxel sea de un EDIFICIO, usando la marca que dejan en el stencil.
    const ghostMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      depthFunc: THREE.GreaterDepth,
      stencilWrite: true,
      stencilRef: BUILDING_STENCIL,
      stencilFunc: THREE.EqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    // La silueta usa la malla entera (con brazos): es una mancha roja tenue, el detalle no se nota.
    this.walkerGhosts = new THREE.InstancedMesh(walker.merged, ghostMaterial, MAX_WALKERS);
    this.tankGhosts = new THREE.InstancedMesh(this.tanks.geometry, ghostMaterial.clone(), MAX_TANKS);
    for (const mesh of [this.walkerGhosts, this.tankGhosts]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      mesh.setColorAt(0, this.color.setHex(0xffffff));
    }

    const corpseGeometry = new THREE.BoxGeometry(1.3, 0.22, 0.6);
    corpseGeometry.translate(0, 0.11, 0);
    this.corpses = new THREE.InstancedMesh(
      corpseGeometry,
      new THREE.MeshStandardMaterial({ color: 0x3b3a2c, roughness: 1 }),
      MAX_CORPSES,
    );
    this.corpses.count = 0;
    this.corpses.receiveShadow = true;
    this.corpses.frustumCulled = false;

    this.root.add(this.walkers, this.armsL, this.armsR, this.tanks, this.corpses, this.walkerGhosts, this.tankGhosts);
  }

  /** alpha: fracción entre el paso anterior y el actual, para interpolar posiciones. */
  update(state: GameState, grid: TileGrid, viewerX: number, viewerY: number, alpha: number): void {
    this.time = state.time;
    let walkers = 0;
    let tanks = 0;
    for (const z of state.zombies) {
      if (z.hp <= 0) continue;
      const x = z.prevX + (z.x - z.prevX) * alpha;
      const y = z.prevY + (z.y - z.prevY) * alpha;
      if (Math.abs(x - viewerX) > DRAW_DISTANCE || Math.abs(y - viewerY) > DRAW_DISTANCE) continue;
      if (!lineOfSight(grid, viewerX, viewerY, x, y)) continue;
      // La silueta se apaga con la distancia: lo lejano y oscuro sigue siendo una amenaza invisible.
      const d = Math.hypot(x - viewerX, y - viewerY);
      const ghost = Math.max(0, 1 - d / GHOST_DISTANCE);
      if (z.kind === 'tank') {
        if (tanks < MAX_TANKS) {
          this.writeGhost(this.tankGhosts, tanks, ghost);
          this.write(this.tanks, tanks++, z, x, y);
        }
      } else if (walkers < MAX_WALKERS) {
        this.writeGhost(this.walkerGhosts, walkers, ghost);
        this.write(this.walkers, walkers++, z, x, y);
      }
    }
    this.finish(this.walkers, walkers);
    this.finish(this.armsL, walkers);
    this.finish(this.armsR, walkers);
    this.finish(this.tanks, tanks);
    this.finish(this.walkerGhosts, walkers);
    this.finish(this.tankGhosts, tanks);
    this.updateCorpses(state);
  }

  private write(mesh: THREE.InstancedMesh, index: number, z: Zombie, x: number, y: number): void {
    this.quaternion.setFromAxisAngle(this.up, -z.facing);
    // Saltando una valla, agarrado o en el salto del tanque va derecho; solo da vueltas el que
    // sale volando (explosión, embestida) o el que lanzó el tanque.
    if (z.air > 0 && z.perch === undefined && (!z.vault || z.vault.kind === 'thrown')) {
      // Volando: da vueltas de carnero (gira en torno a su eje lateral según la altura).
      this.tumble.setFromAxisAngle(this.side, z.air * 1.3 + z.id);
      this.quaternion.multiply(this.tumble);
    }
    const crawling = (z.limbs & LIMB_LEGS) !== 0;
    if (crawling && z.air <= 0) {
      // Sin piernas: el cuerpo tumbado hacia adelante, apoyado en el suelo.
      this.tumble.setFromAxisAngle(this.side, CRAWL_TILT);
      this.quaternion.multiply(this.tumble);
    }
    this.position.set(x, z.air + (crawling ? 0.12 : 0), y);
    // El tanque camina como un simio: se balancea apoyando los puños. Agachado antes de saltar.
    let squash = 1;
    if (z.kind === 'tank' && z.air <= 0) {
      const moving = Math.hypot(z.x - z.prevX, z.y - z.prevY) > 0.01;
      if (moving) {
        const gait = this.time * 7 + z.id;
        this.position.y += Math.abs(Math.sin(gait)) * 0.18;
        this.tumble.setFromAxisAngle(this.side, -Math.sin(gait * 2) * 0.06);
        this.quaternion.multiply(this.tumble);
      }
      if (z.mode === 'leap') squash = 0.72;
    }
    // La sonámbula tiembla más mientras más cerca está de despertar.
    if (z.kind === 'sleeper' && z.agitation) {
      const shake = z.agitation * z.agitation * 0.07;
      this.position.x += Math.sin(this.time * 47 + z.id) * shake;
      this.position.z += Math.cos(this.time * 41 + z.id) * shake;
    }
    // Cada tipo con su silueta: el hinchado es ancho y bajo; el corredor, flaco; el gritón, alto.
    const shape = SHAPES[z.kind];
    // El acechador espera agazapado: más bajo y más ancho. Cuando arranca, se para.
    const crouch = z.role === 'ambusher' && z.mode === 'idle' ? 0.62 : 1;
    this.scale.set(shape[0] * (crouch < 1 ? 1.15 : 1) * (squash < 1 ? 1.12 : 1), shape[1] * crouch * squash * (crawling ? 0.75 : 1), shape[0] * (crouch < 1 ? 1.15 : 1));
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.scale.set(1, 1, 1);
    mesh.setMatrixAt(index, this.matrix);
    const walker = mesh === this.walkers;
    const ghost = walker ? this.walkerGhosts : this.tankGhosts;
    ghost.setMatrixAt(index, this.matrix);
    if (walker) {
      this.armsL.setMatrixAt(index, z.limbs & LIMB_ARM_L ? this.hidden : this.matrix);
      this.armsR.setMatrixAt(index, z.limbs & LIMB_ARM_R ? this.hidden : this.matrix);
    }

    if (z.hitFlash > 0) {
      this.color.setHex(0xffffff);
    } else if (z.kind === 'tank') {
      this.color.setHex(z.mode === 'stunned' ? 0x8a7d5a : z.mode === 'throw' || z.mode === 'leap' ? 0xa04838 : 0x6e5648);
    } else if (z.kind === 'sleeper') {
      // Pálida; despierta, se enrojece.
      this.color.setHex(this.time < z.huntUntil ? 0xe0a090 : 0xd8d4c8);
      if (z.agitation) this.color.lerp(BURN_COLOR, z.agitation * 0.35);
    } else if (z.kind === 'runner') {
      this.color.setHex(0x7a3a30);
    } else if (z.kind === 'bloater') {
      this.color.setHex(0x9aa83a);
    } else if (z.kind === 'screamer') {
      this.color.setHex(z.stagger > 0 && z.ability > 0 ? 0xffffff : 0xb9b0c8);
    } else if (z.kind === 'spitter') {
      // Verde ácido; se aclara justo después de escupir.
      this.color.setHex(z.stagger > 0 && z.ability > 3.5 ? 0xc8f060 : 0x5c9a52);
    } else if (z.armored) {
      // Soldado: verde oliva del uniforme.
      this.color.setHex(0x4d5636);
    } else {
      // Cada zombie con un tono propio entre verde grisáceo y marrón, fijo por su id.
      const t = ((z.id * 0.618034) % 1 + 1) % 1;
      this.color.setRGB(0.36 + t * 0.12, 0.42 + t * 0.05, 0.3 - t * 0.06);
    }
    if (z.burn > 0 && z.hitFlash <= 0.05) {
      // Ardiendo: el color tiembla hacia el naranja (las llamas están en effectsView).
      const flicker = 0.55 + 0.35 * Math.sin(this.time * 23 + z.id * 1.7);
      this.color.lerp(BURN_COLOR, flicker);
    }
    mesh.setColorAt(index, this.color);
    if (walker) {
      this.armsL.setColorAt(index, this.color);
      this.armsR.setColorAt(index, this.color);
    }
  }

  /** La silueta usa la misma matriz que el zombie (se escribe justo después, ver write). */
  private writeGhost(mesh: THREE.InstancedMesh, index: number, strength: number): void {
    this.color.setRGB(0.75 * strength, 0.12 * strength, 0.08 * strength);
    mesh.setColorAt(index, this.color);
  }

  private finish(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private updateCorpses(state: GameState): void {
    // Los cadáveres no se mueven: solo reescribimos cuando cambia la cantidad.
    const list = state.corpses;
    if (state.stats.kills === this.corpseVersion) return;
    this.corpseVersion = state.stats.kills;
    const count = Math.min(list.length, MAX_CORPSES);
    for (let i = 0; i < count; i++) {
      const c = list[list.length - count + i];
      this.quaternion.setFromAxisAngle(this.up, -c.facing);
      this.position.set(c.x, 0, c.y);
      const s = c.kind === 'tank' ? 2.2 : 1;
      this.scale.set(s, s, s);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.corpses.setMatrixAt(i, this.matrix);
    }
    this.scale.set(1, 1, 1);
    this.corpses.count = count;
    this.corpses.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.walkerGhosts, this.tankGhosts]) {
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    for (const mesh of [this.walkers, this.armsL, this.armsR, this.tanks, this.corpses]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.walkerGhosts.geometry.dispose();
  }
}
