// Dibujo del jugador: un muñeco articulado (piernas, torso, cabeza y brazos) con el arma que
// tiene en la mano (una caja de otra forma y color por arma: se lee de un vistazo qué llevas).
//
// Las piernas caminan hacia donde te MUEVES, no hacia donde miras (twin-stick: puedes caminar de
// espaldas disparando). Por eso el paso se descompone en "adelante" y "de costado" respecto de
// la mirada: la parte de adelante gira las piernas como un péndulo hacia el frente, la de costado
// las abre hacia el lado.

import * as THREE from 'three';
import type { MeleeId, WeaponId } from '../game/combat';

/** Forma del arma en la mano: largo, ancho, alto (tiles) y color. */
const HELD: Record<string, [number, number, number, number]> = {
  bat: [0.85, 0.08, 0.08, 0x8a6a40],
  machete: [0.75, 0.03, 0.1, 0xb8c0c8],
  axe: [0.8, 0.05, 0.22, 0x9a8a70],
  sledge: [0.9, 0.2, 0.2, 0x55585c],
  katana: [1.05, 0.03, 0.06, 0xd8e0e8],
  pistol: [0.3, 0.07, 0.12, 0x2a2a2e],
  shotgun: [0.85, 0.08, 0.1, 0x4a3a2a],
  smg: [0.55, 0.08, 0.14, 0x262628],
  minigun: [1.0, 0.24, 0.22, 0x3a3e44],
  flamer: [0.9, 0.12, 0.16, 0x8a2a20],
  rocket: [1.2, 0.17, 0.17, 0x4a5a34],
};

const HIP_Y = 0.78;
const HIP_Z = 0.12;
const SHOULDER_Y = 1.32;
const SHOULDER_Z = 0.25;
/** Altura de las manos (donde va el arma). */
const HAND_Y = 1.12;
/** Radianes de fase por tile caminado, y cuánto se abren las piernas en cada paso. */
const PHASE_PER_TILE = 3.6;
const STRIDE_SWING = 0.6;

export class PlayerView {
  readonly root = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly held: THREE.Mesh;
  private heldKey = '';
  private phase = 0;
  private lastX = NaN;
  private lastY = NaN;
  private lastTime = 0;

  constructor() {
    const jacket = new THREE.MeshStandardMaterial({ color: 0x4fa3ff, roughness: 0.6 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2b3a55, roughness: 0.8 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9b08c, roughness: 0.7 });

    // Piernas: el pivote del grupo es la cadera; la caja cuelga hacia abajo.
    for (const [leg, side] of [[this.legL, -1], [this.legR, 1]] as const) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.17, HIP_Y, 0.17), pants);
      mesh.position.y = -HIP_Y / 2;
      leg.add(mesh);
      leg.position.set(0, HIP_Y, side * HIP_Z);
      this.root.add(leg);
    }

    // Torso, cabeza y brazos van juntos (se mecen con el paso).
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.48), jacket);
    chest.position.y = 1.08;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), skin);
    head.position.y = 1.56;
    // Una gorra con visera: indica hacia dónde mira aunque no se vea el arma.
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.3), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    cap.position.set(0.1, 1.66, 0);
    this.torso.add(chest, head, cap);
    // Brazos: del hombro hacia las manos, que sostienen el arma adelante, al centro.
    for (const side of [-1, 1]) {
      const from = new THREE.Vector3(0.02, SHOULDER_Y, side * SHOULDER_Z);
      const to = new THREE.Vector3(0.42, HAND_Y, side * 0.06 + 0.04);
      const length = from.distanceTo(to);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(length, 0.11, 0.11), jacket);
      arm.position.copy(from).add(to).multiplyScalar(0.5);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), to.clone().sub(from).normalize());
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), skin);
      hand.position.copy(to);
      this.torso.add(arm, hand);
    }
    this.held = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }));
    this.torso.add(this.held);
    this.root.add(this.torso);
    // El jugador no proyecta sombra: la linterna sale de su pecho y su propia sombra la taparía.
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) obj.castShadow = false;
    });
    this.setWeapon('pistol', 'bat');
  }

  /** Cambia el arma que se ve en la mano (solo si cambió). */
  setWeapon(current: WeaponId, melee: MeleeId): void {
    const key = current === 'melee' ? melee : current;
    if (key === this.heldKey) return;
    this.heldKey = key;
    const [length, width, height, color] = HELD[key] ?? HELD.pistol;
    this.held.scale.set(length, height, width);
    // Sale de las manos hacia adelante.
    this.held.position.set(0.36 + length / 2, HAND_Y, 0.04);
    (this.held.material as THREE.MeshStandardMaterial).color.setHex(color);
  }

  /**
   * Ubica la vista en (x, y) del mundo 2D, mirando con el ángulo "facing".
   * Ojo con el signo: en el mundo 2D el ángulo se mide de x hacia y (que en 3D es z),
   * pero en Three.js rotar en torno a Y positivo va de x hacia −z. Por eso se invierte.
   */
  update(x: number, y: number, facing: number, air = 0): void {
    this.root.position.set(x, air, y);
    this.root.rotation.y = -facing;

    // Cuánto y hacia dónde se movió desde el cuadro anterior.
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - this.lastTime);
    this.lastTime = now;
    const dx = Number.isNaN(this.lastX) ? 0 : x - this.lastX;
    const dy = Number.isNaN(this.lastY) ? 0 : y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    const moved = Math.hypot(dx, dy);
    // Un salto grande (reinicio, teletransporte) no cuenta como paso.
    const speed = moved > 1 || dt <= 0 ? 0 : moved / dt;
    this.phase += moved > 1 ? 0 : moved * PHASE_PER_TILE;
    // Parte del paso hacia adelante y de costado, en el marco de la mirada.
    const forward = speed > 0.05 ? (dx * Math.cos(facing) + dy * Math.sin(facing)) / moved : 0;
    const sideways = speed > 0.05 ? (-dx * Math.sin(facing) + dy * Math.cos(facing)) / moved : 0;
    const amount = Math.min(1, speed / 3) * STRIDE_SWING;
    const swing = Math.sin(this.phase) * amount;
    // Adelante: péndulo en torno al eje lateral (z). De costado: se abren en torno al eje x.
    this.legL.rotation.set(swing * sideways, 0, swing * forward);
    this.legR.rotation.set(-swing * sideways, 0, -swing * forward);
    // El cuerpo sube y baja un poco con cada paso.
    this.torso.position.y = Math.abs(Math.cos(this.phase)) * amount * 0.07;
    this.torso.rotation.x = Math.sin(this.phase) * amount * 0.06;
  }

  dispose(): void {
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }
}
