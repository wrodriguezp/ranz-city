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
// Los zombies comunes se dibujan en CINCO mallas instanciadas: cuerpo (torso y cabeza), dos
// brazos y dos piernas. Cada brazo y pierna es una "articulación": su matriz es la del cuerpo
// multiplicada por un giro en el hombro o la cadera, y el ángulo sale de una fase de paso que
// avanza según cuánto camina ese zombie. Así cientos de zombies caminan moviendo las piernas
// y siguen siendo cinco llamadas de dibujo. Un brazo cortado es "no dibujar esa instancia" (una
// matriz de escala cero). Sin piernas se dibuja tumbado hacia adelante, arrastrándose. El
// tanque, que nunca pierde miembros, sigue en una sola malla.

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

// --- Esqueleto del caminante (tiles; el frente es +x y su izquierda es -z) --------------------
const HIP_Y = 0.66;
const HIP_Z = 0.14;
const SHOULDER_X = 0.12;
const SHOULDER_Y = 1.28;
const SHOULDER_Z = 0.27;
const ARM_LENGTH = 0.58;
/** Cuánto gira la pierna (radianes) en cada paso, y cuántos radianes de fase por tile caminado. */
const STRIDE_SWING = 0.55;
const PHASE_PER_TILE = 4.2;

/**
 * Las piezas del caminante. Brazos y piernas se arman con el pivote en el origen (hombro o
 * cadera), así girarlos es solo multiplicar por una rotación antes de ubicarlos.
 */
function walkerParts() {
  const torso = new THREE.CapsuleGeometry(0.3, 0.3, 4, 10);
  torso.translate(0, 1.05, 0);
  // La cabeza un poco adelantada: encorvado, como buscando.
  const head = new THREE.SphereGeometry(0.19, 10, 8);
  head.translate(0.08, 1.6, 0);
  const body = mergeGeometries([torso.toNonIndexed(), head.toNonIndexed()]) ?? torso;
  const arm = new THREE.BoxGeometry(ARM_LENGTH, 0.11, 0.11);
  arm.translate(ARM_LENGTH / 2, 0, 0);
  const leg = new THREE.BoxGeometry(0.17, HIP_Y, 0.17);
  leg.translate(0, -HIP_Y / 2, 0);
  // La silueta (para cuando un edificio lo tapa) va de una pieza, en pose quieta.
  const posed = (g: THREE.BufferGeometry, x: number, y: number, z: number) => g.clone().translate(x, y, z).toNonIndexed();
  const merged =
    mergeGeometries([
      body.clone(),
      posed(arm, SHOULDER_X, SHOULDER_Y, -SHOULDER_Z),
      posed(arm, SHOULDER_X, SHOULDER_Y, SHOULDER_Z),
      posed(leg, 0, HIP_Y, -HIP_Z),
      posed(leg, 0, HIP_Y, HIP_Z),
    ]) ?? body;
  return { body, arm, leg, merged };
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
  private readonly legsL: THREE.InstancedMesh;
  private readonly legsR: THREE.InstancedMesh;
  private readonly tanks: THREE.InstancedMesh;
  /** Fase del paso de cada zombie (solo dibujo: no es estado del juego). */
  private readonly gait = new Map<number, { phase: number; seen: number }>();
  private readonly local = new THREE.Matrix4();
  private readonly limb = new THREE.Matrix4();
  private lastFrame = 0;
  private frameDt = 0;
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
    const walker = walkerParts();
    this.walkers = new THREE.InstancedMesh(walker.body, material, MAX_WALKERS);
    this.armsL = new THREE.InstancedMesh(walker.arm, material, MAX_WALKERS);
    this.armsR = new THREE.InstancedMesh(walker.arm, material, MAX_WALKERS);
    this.legsL = new THREE.InstancedMesh(walker.leg, material, MAX_WALKERS);
    this.legsR = new THREE.InstancedMesh(walker.leg, material, MAX_WALKERS);
    this.tanks = new THREE.InstancedMesh(tankParts(), material.clone(), MAX_TANKS);
    for (const mesh of [this.walkers, this.armsL, this.armsR, this.legsL, this.legsR, this.tanks]) {
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

    this.root.add(this.walkers, this.armsL, this.armsR, this.legsL, this.legsR, this.tanks, this.corpses, this.walkerGhosts, this.tankGhosts);
  }

  /** alpha: fracción entre el paso anterior y el actual, para interpolar posiciones. */
  update(state: GameState, grid: TileGrid, viewerX: number, viewerY: number, alpha: number): void {
    this.time = state.time;
    const now = performance.now() / 1000;
    this.frameDt = this.lastFrame ? Math.min(0.1, now - this.lastFrame) : 0;
    this.lastFrame = now;
    // Cada tanto se olvida la fase de los zombies que ya no están (muertos o lejos).
    if (this.gait.size > 1500) for (const [id, g] of this.gait) if (now - g.seen > 3) this.gait.delete(id);
    let walkers = 0;
    let tanks = 0;
    for (const z of state.zombies) {
      if (z.hp <= 0) continue;
      const x = z.prevX + (z.x - z.prevX) * alpha;
      const y = z.prevY + (z.y - z.prevY) * alpha;
      if (Math.abs(x - viewerX) > DRAW_DISTANCE || Math.abs(y - viewerY) > DRAW_DISTANCE) continue;
      // El de un techo está dentro del edificio: se prueba la vista hasta el borde, frente a él.
      const lx = z.perch !== undefined ? x + Math.cos(z.facing) * 0.9 : x;
      const ly = z.perch !== undefined ? y + Math.sin(z.facing) * 0.9 : y;
      if (!lineOfSight(grid, viewerX, viewerY, lx, ly)) continue;
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
    this.finish(this.legsL, walkers);
    this.finish(this.legsR, walkers);
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
    if (walker) this.writeLimbs(index, z, crawling);

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
      // Las piernas un poco más oscuras (pantalón sucio).
      this.color.multiplyScalar(0.7);
      this.legsL.setColorAt(index, this.color);
      this.legsR.setColorAt(index, this.color);
    }
  }

  /**
   * Brazos y piernas articulados. La fase avanza con lo que camina (rápido = pasos rápidos);
   * las piernas van en contrafase y los brazos estirados se mecen un poco, a destiempo.
   */
  private writeLimbs(index: number, z: Zombie, crawling: boolean): void {
    let g = this.gait.get(z.id);
    if (!g) {
      g = { phase: z.id * 1.7, seen: 0 };
      this.gait.set(z.id, g);
    }
    g.seen = this.lastFrame;
    const speed = Math.hypot(z.x - z.prevX, z.y - z.prevY) * 60;
    g.phase += speed * PHASE_PER_TILE * this.frameDt;
    const stride = Math.min(1, speed / 1.2) * STRIDE_SWING * (z.kind === 'runner' ? 1.4 : 1);
    // En el aire (saltando, volando) patalea; parado, apenas se balancea.
    const flail = z.air > 0 ? Math.sin(this.time * 14 + z.id) * 0.6 : 0;
    const swing = Math.sin(g.phase) * stride + flail;
    const sway = Math.sin(this.time * 2.1 + z.id) * 0.06;

    const leg = (mesh: THREE.InstancedMesh, side: number, angle: number) => {
      if (crawling) {
        mesh.setMatrixAt(index, this.hidden);
        return;
      }
      this.local.makeRotationZ(angle).setPosition(0, HIP_Y, side * HIP_Z);
      mesh.setMatrixAt(index, this.limb.multiplyMatrices(this.matrix, this.local));
    };
    leg(this.legsL, -1, swing);
    leg(this.legsR, 1, -swing);

    const arm = (mesh: THREE.InstancedMesh, side: number, bit: number, angle: number) => {
      if (z.limbs & bit) {
        mesh.setMatrixAt(index, this.hidden);
        return;
      }
      // Ángulo levemente hacia abajo (brazos estirados que pesan) más el vaivén del paso.
      this.local.makeRotationZ(-0.12 + angle).setPosition(SHOULDER_X, SHOULDER_Y, side * SHOULDER_Z);
      mesh.setMatrixAt(index, this.limb.multiplyMatrices(this.matrix, this.local));
    };
    arm(this.armsL, -1, LIMB_ARM_L, -swing * 0.35 + sway);
    arm(this.armsR, 1, LIMB_ARM_R, swing * 0.35 - sway);
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
    // armsL/armsR y legsL/legsR comparten geometría: dispose() repetido no hace daño.
    for (const mesh of [this.walkers, this.armsL, this.armsR, this.legsL, this.legsR, this.tanks, this.corpses]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.walkerGhosts.geometry.dispose();
  }
}
