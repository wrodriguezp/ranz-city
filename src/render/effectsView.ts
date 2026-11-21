// Efectos visuales que reaccionan a los eventos del juego: trazadoras de bala, fogonazos, chispas,
// salpicaduras, trozos de zombie, el arco del golpe y manchas de sangre en el suelo.
// Solo dibujo: la lógica ya resolvió quién recibió el daño. Por eso aquí SÍ se puede usar
// Math.random(): nada de esto afecta la partida, y no hace falta que se repita igual.
//
// Partículas: en vez de un objeto de Three.js por partícula (cientos de llamadas de dibujo),
// hay dos InstancedMesh (trozos sólidos y chispas brillantes) y un arreglo de datos simples.
// Cada cuadro se integra la física a mano (velocidad, gravedad, rebote) y se reescriben las
// matrices: es lo mismo que hacemos con los zombies.

import * as THREE from 'three';
import type { GameEvent } from '../game/state';
import type { NightLighting } from './lighting';

const MAX_BLOOD = 300;
const MAX_CHUNKS = 600;
const MAX_SPARKS = 500;
const TRACER_LIFE = 0.09;
const SWING_LIFE = 0.14;
const FLASH_LIFE = 0.05;
const GRAVITY = 22;

interface Fading {
  object: THREE.Object3D;
  material: THREE.Material & { opacity: number };
  life: number;
  maxLife: number;
  peak: number;
  /** Crece mientras se desvanece (ondas de choque, bolas de fuego). */
  grow?: number;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  spin: number;
  angle: number;
  /** Los trozos se quedan en el suelo y se achican al final; las chispas se apagan en el aire. */
  sticky: boolean;
  /** Alargamiento en un eje (brazos y piernas arrancados son cajas largas, no cubos). */
  stretch?: number;
  /** Multiplicador de la gravedad (las llamas suben: negativo). */
  gravity?: number;
}

/** Color de piel de cada tipo, para que el brazo arrancado sea del mismo zombie. */
const SKIN: Record<string, number> = {
  walker: 0x6b7350,
  runner: 0x7a6a52,
  bloater: 0x8a9a40,
  screamer: 0xb9b0c8,
  spitter: 0x5c9a52,
  tank: 0x6a5a48,
};

export class EffectsView {
  readonly root = new THREE.Group();
  private readonly fading: Fading[] = [];
  private readonly blood: THREE.InstancedMesh;
  private bloodNext = 0;
  private readonly chunks: THREE.InstancedMesh;
  private readonly sparks: THREE.InstancedMesh;
  private readonly chunkData: Particle[] = [];
  private readonly sparkData: Particle[] = [];
  private chunkNext = 0;
  private sparkNext = 0;
  private readonly swingGeometry = new THREE.RingGeometry(0.6, 1.9, 20, 1, -Math.PI / 3, (Math.PI * 2) / 3);
  private readonly tracerGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly flashGeometry = new THREE.OctahedronGeometry(0.35);
  private readonly fireGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly ringGeometry = new THREE.RingGeometry(0.85, 1, 40);
  private readonly scorchGeometry = new THREE.CircleGeometry(1, 18);
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(private readonly lighting: NightLighting) {
    const bloodGeometry = new THREE.CircleGeometry(0.45, 10);
    bloodGeometry.rotateX(-Math.PI / 2);
    this.blood = new THREE.InstancedMesh(
      bloodGeometry,
      new THREE.MeshStandardMaterial({ color: 0x4a0b0b, roughness: 0.6, transparent: true, opacity: 0.85 }),
      MAX_BLOOD,
    );
    this.blood.count = 0;
    this.blood.frustumCulled = false;
    this.blood.receiveShadow = true;

    // Trozos: cubitos de carne que reciben luz (en la oscuridad casi no se ven; con la linterna, sí).
    this.chunks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.7 }),
      MAX_CHUNKS,
    );
    // Chispas y gotas: MeshBasic con mezcla aditiva, brillan solas (se ven aunque no haya luz).
    this.sparks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_SPARKS,
    );
    for (const mesh of [this.chunks, this.sparks]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.setColorAt(0, this.color.setHex(0xffffff));
    }
    this.chunks.castShadow = true;
    this.root.add(this.blood, this.chunks, this.sparks);
  }

  handle(events: readonly GameEvent[], seedNoise: number): void {
    for (const event of events) {
      switch (event.type) {
        case 'shot':
          this.tracer(event.fromX, event.fromY, event.toX, event.toY, event.weapon === 'pistol' ? 0.06 : 0.045);
          // La escopeta son 9 perdigones, pero un solo fogonazo (más grande).
          if (event.first) {
            this.muzzleFlash(event.fromX, event.fromY, event.weapon === 'shotgun' ? 1.8 : 1);
            this.lighting.flash(event.fromX, event.fromY);
          }
          if (event.hit === 'wall') this.burst(event.toX, event.toY, 1.0, 8, 0xffc070, 6, false);
          break;
        case 'swing': {
          const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.35,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const mesh = new THREE.Mesh(this.swingGeometry, material);
          // El anillo está en el plano XY; lo acostamos y lo giramos hacia donde mira el jugador.
          mesh.rotation.set(-Math.PI / 2, 0, -event.facing);
          mesh.position.set(event.x, 0.6, event.y);
          this.add(mesh, material, SWING_LIFE, 0.35);
          break;
        }
        case 'hit':
          this.hit(event);
          break;
        case 'blood':
          this.decal(event.x, event.y, seedNoise, 1);
          break;
        case 'explosion':
          this.explosion(event.x, event.y, event.radius, event.kind);
          break;
        case 'limb':
          this.limb(event);
          break;
        case 'flame':
          this.flame(event.x, event.y, event.toX, event.toY);
          break;
        default:
          break;
      }
    }
  }

  update(dt: number): void {
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.root.remove(f.object);
        f.material.dispose();
        this.fading.splice(i, 1);
      } else {
        f.material.opacity = (f.life / f.maxLife) * f.peak;
        if (f.grow) f.object.scale.multiplyScalar(1 + f.grow * dt);
      }
    }
    this.integrate(this.chunks, this.chunkData, dt, true);
    this.integrate(this.sparks, this.sparkData, dt, false);
  }

  /** Borra todo (al reiniciar la partida). */
  reset(): void {
    for (const f of this.fading) {
      this.root.remove(f.object);
      f.material.dispose();
    }
    this.fading.length = 0;
    this.bloodNext = 0;
    this.blood.count = 0;
    this.chunkData.length = 0;
    this.sparkData.length = 0;
    this.chunks.count = 0;
    this.sparks.count = 0;
  }

  // --- Efectos ------------------------------------------------------------------------------

  /**
   * Una trazadora es una caja muy fina y larga, estirada entre la boca del arma y el impacto.
   * (Las líneas de WebGL siempre miden 1 píxel de ancho: se veían como un pelo, "toscas").
   */
  private tracer(fromX: number, fromY: number, toX: number, toY: number, width: number): void {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const length = Math.hypot(dx, dy);
    if (length < 0.05) return;
    const material = new THREE.MeshBasicMaterial({
      color: 0xffd79a,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.tracerGeometry, material);
    mesh.position.set(fromX + dx / 2, 1.15, fromY + dy / 2);
    mesh.rotation.y = -Math.atan2(dy, dx);
    mesh.scale.set(length, width, width);
    this.add(mesh, material, TRACER_LIFE, 1);
  }

  private muzzleFlash(x: number, y: number, size: number): void {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffe2a0,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.flashGeometry, material);
    mesh.position.set(x, 1.15, y);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    mesh.scale.setScalar(size);
    this.add(mesh, material, FLASH_LIFE, 1);
  }

  /**
   * Un miembro arrancado: una caja larga del color del zombie que sale volando hacia donde iba
   * el golpe, girando, y queda en el suelo. La cabeza es un cubo que rueda. Más un chorro de sangre.
   */
  private limb(event: Extract<GameEvent, { type: 'limb' }>): void {
    const head = event.part === 'head';
    const legs = event.part === 'legs';
    // Sale del costado correspondiente: el lado izquierdo es perpendicular a la mirada.
    const sx = -Math.sin(event.facing) * event.side * 0.3;
    const sy = Math.cos(event.facing) * event.side * 0.3;
    const count = legs ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const angle = Math.atan2(event.dirY, event.dirX) + (Math.random() - 0.5) * 1.2;
      const speed = 3 + Math.random() * 4;
      const index = this.chunkNext % MAX_CHUNKS;
      const p: Particle = {
        x: event.x + sx,
        y: event.y + sy,
        z: head ? 1.5 : legs ? 0.4 : 1.1,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        vz: head ? 7 : 4 + Math.random() * 3,
        life: 14,
        maxLife: 14,
        size: head ? 0.26 : legs ? 0.17 : 0.12,
        spin: (Math.random() - 0.5) * 16,
        angle: Math.random() * 6,
        sticky: true,
        stretch: head ? 1 : legs ? 4 : 4.5,
      };
      this.chunkData[index] = p;
      this.chunks.setColorAt(index, this.color.setHex(SKIN[event.kind] ?? 0x6b7350));
      this.chunkNext++;
    }
    if (this.chunks.instanceColor) this.chunks.instanceColor.needsUpdate = true;
    // El chorro: sangre hacia arriba desde el muñón.
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spark(event.x + sx, event.y + sy, head ? 1.5 : 1, Math.cos(a) * 2, Math.sin(a) * 2, 4 + Math.random() * 5, 0.5, 0.08, 0x9a1010);
    }
    this.decal(event.x + event.dirX * 0.8, event.y + event.dirY * 0.8, Math.random() * 1000, 0.9);
  }

  /** El chorro del lanzallamas: lenguas de fuego que avanzan y suben. */
  private flame(x: number, y: number, toX: number, toY: number): void {
    const dx = toX - x;
    const dy = toY - y;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = 0; i < 5; i++) {
      const speed = len * (2.4 + Math.random() * 1.6);
      const spread = (Math.random() - 0.5) * 0.35;
      const c = Math.cos(spread);
      const s = Math.sin(spread);
      const ux = (dx * c - dy * s) / len;
      const uy = (dx * s + dy * c) / len;
      const color = Math.random() < 0.3 ? 0xffe080 : Math.random() < 0.6 ? 0xff8a20 : 0xff4a10;
      const index = this.sparkNext % MAX_SPARKS;
      this.sparkData[index] = {
        x: x + ux * 0.5,
        y: y + uy * 0.5,
        z: 1.0,
        vx: ux * speed,
        vy: uy * speed,
        vz: Math.random() * 1.5,
        life: 0.35 + Math.random() * 0.15,
        maxLife: 0.5,
        size: 0.2 + Math.random() * 0.25,
        spin: 0,
        angle: Math.random() * 6,
        sticky: false,
        gravity: -0.15,
      };
      this.sparks.setColorAt(index, this.color.setHex(color));
      this.sparkNext++;
    }
    if (this.sparks.instanceColor) this.sparks.instanceColor.needsUpdate = true;
    this.lighting.flash(x, y);
  }

  /** Fuego sobre algo que arde (zombies, charcos): lo llama hazardsView cada tanto. */
  ember(x: number, y: number, z: number): void {
    const color = Math.random() < 0.5 ? 0xff8a20 : 0xff5010;
    const index = this.sparkNext % MAX_SPARKS;
    this.sparkData[index] = {
      x: x + (Math.random() - 0.5) * 0.4,
      y: y + (Math.random() - 0.5) * 0.4,
      z,
      vx: (Math.random() - 0.5) * 0.6,
      vy: (Math.random() - 0.5) * 0.6,
      vz: 1.5 + Math.random() * 1.5,
      life: 0.4 + Math.random() * 0.3,
      maxLife: 0.7,
      size: 0.14 + Math.random() * 0.14,
      spin: 0,
      angle: Math.random() * 6,
      sticky: false,
      gravity: -0.1,
    };
    this.sparks.setColorAt(index, this.color.setHex(color));
    if (this.sparks.instanceColor) this.sparks.instanceColor.needsUpdate = true;
    this.sparkNext++;
  }

  private hit(event: Extract<GameEvent, { type: 'hit' }>): void {
    const tank = event.kind === 'tank';
    // Salpicadura: gotas rojas que salen hacia donde va el golpe.
    this.spray(event.x, event.y, event.dirX, event.dirY, event.killed ? 14 : 7, 0xb01818);
    if (!event.killed) {
      if (event.crit) this.burst(event.x, event.y, 1.1, 6, 0xffffff, 5, false);
      return;
    }
    // Muerte: más sangre en el suelo, y trozos. Si revienta, muchos más y más rápido.
    const pieces = event.gib ? (tank ? 30 : 18) : tank ? 10 : 5;
    const power = event.gib ? 9 : 5;
    for (let i = 0; i < pieces; i++) this.chunk(event.x, event.y, event.dirX, event.dirY, power, tank);
    // Si revienta, además salen volando brazos y una pierna enteros.
    if (event.gib && !tank && event.kind !== 'bloater') {
      for (const [part, side] of [['arm', -1], ['arm', 1], ['head', 0]] as const) {
        if (Math.random() < 0.7) {
          this.limb({ type: 'limb', x: event.x, y: event.y, dirX: event.dirX, dirY: event.dirY, part, side, kind: event.kind, facing: Math.atan2(event.dirY, event.dirX) });
        }
      }
    }
    const decals = event.gib ? 4 : 2;
    for (let i = 0; i < decals; i++) {
      this.decal(
        event.x + event.dirX * i * 0.6 + (Math.random() - 0.5) * 0.8,
        event.y + event.dirY * i * 0.6 + (Math.random() - 0.5) * 0.8,
        Math.random() * 1000,
        event.gib ? 1.5 : 1.1,
      );
    }
  }

  /**
   * Una explosión, en capas (cada una dura distinto, y eso la hace creíble):
   *  - bola de fuego: esfera aditiva que crece rápido y se apaga en ~0.35 s;
   *  - onda de choque: un anillo en el suelo que se abre hasta el radio de daño (así se LEE
   *    hasta dónde llegó);
   *  - chispas y escombros con física; una mancha negra que queda en el suelo;
   *  - la luz: ilumina la cuadra un instante.
   */
  private explosion(x: number, y: number, radius: number, kind: string): void {
    const bloater = kind === 'bloater';
    const rock = kind === 'rock';
    const fire = (color: number, size: number, life: number, grow: number, peak: number) => {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(this.fireGeometry, material);
      mesh.position.set(x, 0.9, y);
      mesh.scale.setScalar(size);
      this.add(mesh, material, life, peak, grow);
    };
    if (bloater) {
      // El hinchado no es fuego: es una nube de bilis verde.
      fire(0x7fae2a, radius * 0.45, 0.6, 2.2, 0.7);
      this.burst(x, y, 1, 40, 0x9ccf3a, 9, true);
      for (let i = 0; i < 16; i++) this.chunk(x, y, Math.cos(i), Math.sin(i), 9, false);
    } else if (rock) {
      for (let i = 0; i < 12; i++) this.debris(x, y, 6);
      this.burst(x, y, 0.4, 14, 0xbfae90, 6, false);
    } else {
      fire(0xffffff, radius * 0.22, 0.12, 9, 1);
      fire(0xff9a2a, radius * 0.35, 0.38, 3.2, 0.95);
      fire(0xff4a10, radius * 0.5, 0.55, 1.6, 0.5);
      this.burst(x, y, 1, 70, 0xffb040, 16, true);
      this.burst(x, y, 1, 30, 0xfff0a0, 10, false);
      for (let i = 0; i < 18; i++) this.debris(x, y, 11);
      this.lighting.blast(x, y, radius);
    }
    // Onda de choque en el suelo.
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: bloater ? 0xb4e05a : 0xffd8a0,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.08, y);
    ring.scale.setScalar(radius * 0.3);
    // Crece de 0.3·radio a ~radio en su vida: e^(grow·life) ≈ 3.3.
    this.add(ring, ringMaterial, 0.3, 0.8, 4);
    // Mancha que queda: quemadura o charco verde.
    if (!rock) {
      const scorchMaterial = new THREE.MeshBasicMaterial({ color: bloater ? 0x2a3a10 : 0x050505, transparent: true, opacity: 0.75, depthWrite: false });
      const scorch = new THREE.Mesh(this.scorchGeometry, scorchMaterial);
      scorch.rotation.x = -Math.PI / 2;
      scorch.position.set(x, 0.025, y);
      scorch.scale.setScalar(radius * 0.55);
      this.add(scorch, scorchMaterial, 40, 0.75);
    }
  }

  /** Escombros grises (pavimento, metal del barril). */
  private debris(x: number, y: number, power: number): void {
    const angle = Math.random() * Math.PI * 2;
    const speed = power * (0.3 + Math.random() * 0.8);
    const index = this.chunkNext % MAX_CHUNKS;
    const p: Particle = {
      x,
      y,
      z: 0.5,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      vz: 4 + Math.random() * 9,
      life: 5 + Math.random() * 3,
      maxLife: 8,
      size: 0.12 + Math.random() * 0.2,
      spin: (Math.random() - 0.5) * 24,
      angle: Math.random() * 6,
      sticky: true,
    };
    this.chunkData[index] = p;
    const g = 0.2 + Math.random() * 0.2;
    this.chunks.setColorAt(index, this.color.setRGB(g, g * 0.95, g * 0.9));
    this.chunkNext++;
    if (this.chunks.instanceColor) this.chunks.instanceColor.needsUpdate = true;
  }

  private chunk(x: number, y: number, dirX: number, dirY: number, power: number, tank: boolean): void {
    const angle = Math.atan2(dirY, dirX) + (Math.random() - 0.5) * 2.2;
    const speed = power * (0.4 + Math.random() * 0.8);
    const p: Particle = {
      x,
      y,
      z: 0.9 + Math.random() * 0.5,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      vz: 3 + Math.random() * 6,
      life: 6 + Math.random() * 4,
      maxLife: 10,
      size: (tank ? 0.22 : 0.12) + Math.random() * 0.16,
      spin: (Math.random() - 0.5) * 20,
      angle: Math.random() * 6,
      sticky: true,
    };
    p.maxLife = p.life;
    this.chunkData[this.chunkNext % MAX_CHUNKS] = p;
    // Carne oscura con variaciones: entre rojo sangre y verde podrido.
    const t = Math.random();
    this.color.setRGB(0.35 + t * 0.25, 0.08 + (1 - t) * 0.15, 0.06);
    this.chunks.setColorAt(this.chunkNext % MAX_CHUNKS, this.color);
    this.chunkNext++;
    if (this.chunks.instanceColor) this.chunks.instanceColor.needsUpdate = true;
  }

  private spray(x: number, y: number, dirX: number, dirY: number, count: number, color: number): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.atan2(dirY, dirX) + (Math.random() - 0.5) * 1.4;
      const speed = 3 + Math.random() * 6;
      this.spark(x, y, 1.0, Math.cos(angle) * speed, Math.sin(angle) * speed, 1 + Math.random() * 4, 0.35, 0.09, color);
    }
  }

  /** Chispas en todas direcciones (impacto de bala en la pared, crítico). */
  burst(x: number, y: number, z: number, count: number, color: number, speed: number, big: boolean): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.9);
      this.spark(x, y, z, Math.cos(angle) * s, Math.sin(angle) * s, 1 + Math.random() * (big ? 9 : 4), big ? 0.6 : 0.2, big ? 0.16 : 0.07, color);
    }
  }

  private spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, color: number): void {
    const index = this.sparkNext % MAX_SPARKS;
    this.sparkData[index] = { x, y, z, vx, vy, vz, life, maxLife: life, size, spin: 0, angle: Math.random() * 6, sticky: false };
    this.sparks.setColorAt(index, this.color.setHex(color));
    if (this.sparks.instanceColor) this.sparks.instanceColor.needsUpdate = true;
    this.sparkNext++;
  }

  private decal(x: number, y: number, k: number, size: number): void {
    // Posición y giro "al azar" pero sin Math.random: derivados de un contador.
    const n = this.bloodNext + k;
    const ox = Math.sin(n * 12.9898) * 0.3;
    const oy = Math.cos(n * 78.233) * 0.3;
    const scale = (0.6 + ((n * 0.618) % 1) * 0.8) * size;
    this.euler.set(0, n, 0);
    this.quaternion.setFromEuler(this.euler);
    this.matrix.compose(
      this.position.set(x + ox, 0.02 + (this.bloodNext % 7) * 0.001, y + oy),
      this.quaternion,
      this.scale.set(scale, 1, scale),
    );
    this.blood.setMatrixAt(this.bloodNext % MAX_BLOOD, this.matrix);
    this.bloodNext++;
    this.blood.count = Math.min(this.bloodNext, MAX_BLOOD);
    this.blood.instanceMatrix.needsUpdate = true;
  }

  /** Física de partículas: gravedad, rebote contra el suelo y roce. Después, escribir matrices. */
  private integrate(mesh: THREE.InstancedMesh, list: Particle[], dt: number, solid: boolean): void {
    let alive = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.life <= 0) {
        mesh.setMatrixAt(i, this.hidden);
        continue;
      }
      alive++;
      p.life -= dt;
      p.vz -= GRAVITY * dt * (p.gravity ?? (solid ? 1 : 0.6));
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const floor = p.size / 2;
      if (p.z < floor) {
        p.z = floor;
        if (p.sticky) {
          // Rebota poco y se arrastra hasta quedar quieto en el suelo.
          p.vz = Math.abs(p.vz) > 2 ? -p.vz * 0.3 : 0;
          p.vx *= 0.55;
          p.vy *= 0.55;
          p.spin *= 0.5;
        } else {
          p.life = Math.min(p.life, 0.05);
        }
      }
      p.angle += p.spin * dt;
      // Los trozos se achican el último segundo; las chispas, durante toda su vida.
      const fade = p.sticky ? Math.min(1, p.life) : p.life / p.maxLife;
      const s = p.size * fade;
      // Un miembro en el suelo queda acostado (gira solo en el eje vertical).
      const resting = p.stretch !== undefined && p.z <= floor + 0.001 && p.vz === 0;
      this.euler.set(resting ? 0 : p.angle, p.angle * 0.7, 0);
      this.quaternion.setFromEuler(this.euler);
      this.matrix.compose(this.position.set(p.x, p.z, p.y), this.quaternion, this.scale.set(s * (p.stretch ?? 1), s, s));
      mesh.setMatrixAt(i, this.matrix);
    }
    mesh.count = alive > 0 ? list.length : 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  private add(object: THREE.Object3D, material: Fading['material'], life: number, peak: number, grow?: number): void {
    this.root.add(object);
    this.fading.push({ object, material, life, maxLife: life, peak, grow });
  }
}
