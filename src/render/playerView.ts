// Dibujo del jugador: una cápsula con una "nariz" que indica hacia dónde mira, y el arma que
// tiene en la mano (una caja de otra forma y color por arma: se lee de un vistazo qué llevas).

import * as THREE from 'three';
import type { MeleeId, WeaponId } from '../game/combat';
import { PLAYER_RADIUS } from '../game/player';

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

/** Altura total del personaje, en tiles (un tile es como 1 metro). */
const BODY_HEIGHT = 1.6;

export class PlayerView {
  readonly root = new THREE.Group();

  constructor() {
    const body = new THREE.Mesh(
      // Una cápsula mide length + 2 radios de alto.
      new THREE.CapsuleGeometry(PLAYER_RADIUS, BODY_HEIGHT - PLAYER_RADIUS * 2, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0x4fa3ff, roughness: 0.6 }),
    );
    body.position.y = BODY_HEIGHT / 2;
    // El jugador no proyecta sombra: la linterna sale de su pecho y su propia sombra la taparía.
    body.castShadow = false;

    // La nariz apunta hacia +x local; al rotar el grupo, apunta hacia donde mira el jugador.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.18, 0.18),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
    );
    nose.position.set(PLAYER_RADIUS + 0.1, BODY_HEIGHT * 0.7, 0);
    

    this.held = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }));
    this.held.castShadow = false;
    this.root.add(body, nose, this.held);
    this.setWeapon('pistol', 'bat');
  }

  private readonly held: THREE.Mesh;
  private heldKey = '';

  /** Cambia el arma que se ve en la mano (solo si cambió). */
  setWeapon(current: WeaponId, melee: MeleeId): void {
    const key = current === 'melee' ? melee : current;
    if (key === this.heldKey) return;
    this.heldKey = key;
    const [length, width, height, color] = HELD[key] ?? HELD.pistol;
    this.held.scale.set(length, height, width);
    // Sale de la mano derecha (lado +z local) hacia adelante.
    this.held.position.set(PLAYER_RADIUS + length / 2 - 0.1, BODY_HEIGHT * 0.55, 0.3);
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
