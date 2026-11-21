// Primera persona (experimental, tecla P).
//
// La simulación no cambia nada: el juego sigue siendo 2D por dentro. Solo cambia cómo se mira
// y cómo se traduce el input:
//  - La cámara es de perspectiva y va a la altura de los ojos, girada con el mouse. Usamos
//    Pointer Lock: el navegador esconde el puntero y nos da solo cuánto se movió (movementX/Y),
//    así se puede girar sin tope.
//  - WASD se mueve relativo a hacia dónde miras (W = adelante), no a la pantalla.
//  - El "apuntar al mouse" del modo isométrico se reemplaza por un punto en el suelo, delante
//    de los ojos: la linterna y los disparos van hacia el centro de la pantalla.

import * as THREE from 'three';

const EYE_HEIGHT = 1.55;
/** Radianes por píxel de movimiento del mouse. */
const SENSITIVITY = 0.0024;
const MAX_PITCH = 0.9;
/** A qué distancia, delante de los ojos, está el punto al que se apunta (tiles). */
const AIM_DISTANCE = 8;

export class FirstPerson {
  readonly camera = new THREE.PerspectiveCamera(72, 1, 0.05, 200);
  active = false;
  /** Hacia dónde mira, en el ángulo del mundo 2D (de x hacia y). */
  yaw = 0;
  private pitch = -0.08;

  constructor(private readonly canvas: HTMLCanvasElement) {
    document.addEventListener('mousemove', (event) => {
      if (!this.active || document.pointerLockElement !== this.canvas) return;
      this.yaw += event.movementX * SENSITIVITY;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH * 0.6, this.pitch - event.movementY * SENSITIVITY));
    });
    // Si se perdió el bloqueo del puntero (Esc, cambio de ventana), un clic lo recupera.
    canvas.addEventListener('mousedown', () => {
      if (this.active && document.pointerLockElement !== canvas) this.lock();
    });
  }

  /** Entra o sale. Al entrar, arranca mirando hacia donde miraba el personaje. */
  toggle(facing: number): void {
    this.active = !this.active;
    if (this.active) {
      this.yaw = facing;
      this.pitch = -0.08;
      this.lock();
    } else if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Ojos sobre el jugador (con el salto/empujón de altura, air). */
  update(x: number, y: number, air: number): void {
    this.camera.position.set(x, EYE_HEIGHT + air, y);
    // Dirección de la mirada en 3D: el (x, y) del mundo es (x, z) en Three.js.
    const c = Math.cos(this.pitch);
    this.camera.lookAt(x + Math.cos(this.yaw) * c, EYE_HEIGHT + air + Math.sin(this.pitch), y + Math.sin(this.yaw) * c);
  }

  /** WASD en el marco de la mirada: move.y es adelante, move.x es a la derecha. */
  move(move: { x: number; y: number }): { x: number; y: number } {
    const fx = Math.cos(this.yaw);
    const fy = Math.sin(this.yaw);
    // La derecha de la mirada en el mundo 2D es (-sen, cos).
    return { x: move.y * fx - move.x * fy, y: move.y * fy + move.x * fx };
  }

  aim(x: number, y: number): { x: number; y: number } {
    return { x: x + Math.cos(this.yaw) * AIM_DISTANCE, y: y + Math.sin(this.yaw) * AIM_DISTANCE };
  }

  /** Eje "derecha de la pantalla" en el suelo, para el paneo del sonido. */
  right(): { x: number; y: number } {
    return { x: -Math.sin(this.yaw), y: Math.cos(this.yaw) };
  }

  private lock(): void {
    // Puede fallar si el navegador no lo permite en ese momento: se reintenta al hacer clic.
    try {
      const pending = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      pending?.catch?.(() => undefined);
    } catch {
      /* nada */
    }
  }
}
