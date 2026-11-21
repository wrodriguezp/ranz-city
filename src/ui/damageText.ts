// Números de daño flotantes: "60", "180!" en amarillo si fue crítico.
//
// Son elementos HTML encima del canvas. Cada cuadro se proyecta su posición del mundo 3D a la
// pantalla con la cámara (Vector3.project da coordenadas de -1 a 1, que pasamos a píxeles).
// Con pocos números a la vez (máximo 40) el DOM alcanza de sobra y el texto se ve nítido.

import * as THREE from 'three';
import type { GameEvent } from '../game/state';

const LIFE = 0.8;
const MAX = 40;

interface Floating {
  el: HTMLElement;
  x: number;
  y: number;
  /** Altura sobre el suelo: sube mientras vive. */
  z: number;
  drift: number;
  born: number;
}

export class DamageText {
  private readonly root: HTMLElement;
  private readonly live: Floating[] = [];
  private readonly point = new THREE.Vector3();

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'damage-text';
    document.body.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  handle(events: readonly GameEvent[], now: number): void {
    for (const event of events) {
      if (event.type !== 'hit' || event.damage <= 0) continue;
      const el = document.createElement('div');
      el.className = `dmg${event.crit ? ' crit' : ''}${event.killed ? ' kill' : ''}`;
      el.textContent = event.crit ? `${event.damage}!` : String(event.damage);
      this.root.appendChild(el);
      this.live.push({ el, x: event.x, y: event.y, z: 1.8, drift: (Math.random() - 0.5) * 0.8, born: now });
      while (this.live.length > MAX) this.live.shift()!.el.remove();
    }
  }

  update(camera: THREE.Camera, now: number): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const f = this.live[i];
      const age = now - f.born;
      if (age > LIFE) {
        f.el.remove();
        this.live.splice(i, 1);
        continue;
      }
      // Sube rápido al principio y se frena (ease-out), mientras se desvanece.
      const t = age / LIFE;
      this.point.set(f.x + f.drift * t, f.z + 1.4 * (1 - (1 - t) * (1 - t)), f.y).project(camera);
      const sx = (this.point.x * 0.5 + 0.5) * width;
      const sy = (-this.point.y * 0.5 + 0.5) * height;
      const pop = age < 0.08 ? 1.5 - age * 6 : 1;
      f.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%) scale(${pop.toFixed(2)})`;
      f.el.style.opacity = String(t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
    }
  }

  clear(): void {
    for (const f of this.live) f.el.remove();
    this.live.length = 0;
  }
}
