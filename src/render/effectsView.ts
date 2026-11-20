// Efectos visuales que reaccionan a los eventos del juego: trazadoras de bala, el arco del golpe
// y manchas de sangre en el suelo. Solo dibujo: la lógica ya resolvió quién recibió el daño.

import * as THREE from 'three';
import type { GameEvent } from '../game/state';
import type { NightLighting } from './lighting';

const MAX_BLOOD = 250;
const TRACER_LIFE = 0.07;
const SWING_LIFE = 0.14;

interface Fading {
  object: THREE.Object3D;
  material: THREE.Material & { opacity: number };
  life: number;
  maxLife: number;
}

export class EffectsView {
  readonly root = new THREE.Group();
  private readonly fading: Fading[] = [];
  private readonly blood: THREE.InstancedMesh;
  private bloodNext = 0;
  private readonly swingGeometry = new THREE.RingGeometry(0.6, 1.8, 20, 1, -Math.PI / 3, (Math.PI * 2) / 3);
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();

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
    this.root.add(this.blood);
  }

  handle(events: readonly GameEvent[], seedNoise: number): void {
    for (const event of events) {
      switch (event.type) {
        case 'shot': {
          const geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(event.fromX, 1.2, event.fromY),
            new THREE.Vector3(event.toX, 1.0, event.toY),
          ]);
          const material = new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 1 });
          this.add(new THREE.Line(geometry, material), material, TRACER_LIFE);
          this.lighting.flash(event.fromX, event.fromY);
          break;
        }
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
          this.add(mesh, material, SWING_LIFE);
          break;
        }
        case 'blood': {
          // Posición y giro "al azar" pero sin Math.random: derivados de la posición y un contador.
          const k = this.bloodNext + seedNoise;
          const ox = Math.sin(k * 12.9898) * 0.3;
          const oy = Math.cos(k * 78.233) * 0.3;
          const scale = 0.6 + ((k * 0.618) % 1) * 0.8;
          this.euler.set(0, k, 0);
          this.quaternion.setFromEuler(this.euler);
          this.matrix.compose(
            new THREE.Vector3(event.x + ox, 0.02 + (this.bloodNext % 7) * 0.001, event.y + oy),
            this.quaternion,
            new THREE.Vector3(scale, 1, scale),
          );
          this.blood.setMatrixAt(this.bloodNext % MAX_BLOOD, this.matrix);
          this.bloodNext++;
          this.blood.count = Math.min(this.bloodNext, MAX_BLOOD);
          this.blood.instanceMatrix.needsUpdate = true;
          break;
        }
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
        if (f.object instanceof THREE.Line) f.object.geometry.dispose();
        f.material.dispose();
        this.fading.splice(i, 1);
      } else {
        f.material.opacity = (f.life / f.maxLife) * (f.object instanceof THREE.Line ? 1 : 0.35);
      }
    }
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
  }

  private add(object: THREE.Object3D, material: Fading['material'], life: number): void {
    this.root.add(object);
    this.fading.push({ object, material, life, maxLife: life });
  }
}
