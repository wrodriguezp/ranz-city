// Dibujo del jugador: una cápsula con una "nariz" que indica hacia dónde mira.

import * as THREE from 'three';
import { PLAYER_RADIUS } from '../game/player';

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
    

    this.root.add(body, nose);
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
