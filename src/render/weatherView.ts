// Clima en pantalla: lluvia (gotas que caen alrededor del jugador) y niebla (THREE.Fog).
//
// Lluvia: unas mil vetas en una InstancedMesh, dentro de una caja que sigue al jugador. Cada
// gota tiene una posición fija en la caja y su altura sale del tiempo (módulo la altura de la
// caja): cae para siempre sin guardar estado. Al moverse la caja, las gotas "envuelven" (otra
// vez módulo) para que nunca se vea el borde.
//
// Niebla: con cámara ortográfica, la niebla de three.js depende de la profundidad (distancia
// a la cámara en su eje). La cámara de juego está a 120 de su objetivo, así que poniendo la
// niebla entre ~96 y ~134 lo cercano al jugador queda limpio y lo lejano (arriba en pantalla,
// y el suelo detrás de los edificios) se pierde en gris.

import * as THREE from 'three';
import type { Weather } from '../world/weather';

const DROPS = 1100;
const AREA = 56;
const HEIGHT = 22;
const FALL_SPEED = 26;
const FOG_COLOR = 0x2c323b;

export class WeatherView {
  readonly root = new THREE.Group();
  private readonly rain?: THREE.InstancedMesh;
  private readonly seeds: Float32Array;
  private readonly matrix = new THREE.Matrix4();
  private readonly tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 1).normalize(), 0.12);
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly pos = new THREE.Vector3();
  private readonly fog: THREE.Fog | null;
  /** Fondo original de la escena (noche): con niebla, el vacío fuera de la ciudad también es niebla. */
  private readonly background = new THREE.Color(0x05060a);

  constructor(
    private readonly scene: THREE.Scene,
    readonly weather: Weather,
  ) {
    // Posiciones de las gotas en la caja (siempre las mismas: no importa la seed).
    this.seeds = new Float32Array(DROPS * 3);
    let s = 12345;
    const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = rand();

    if (weather === 'rain') {
      const streak = new THREE.BoxGeometry(0.03, 0.9, 0.03);
      const material = new THREE.MeshBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.35, depthWrite: false });
      this.rain = new THREE.InstancedMesh(streak, material, DROPS);
      this.rain.frustumCulled = false;
      this.root.add(this.rain);
    }
    this.fog = weather === 'fog' ? new THREE.Fog(FOG_COLOR, 96, 134) : weather === 'rain' ? new THREE.Fog(0x0b0e13, 118, 175) : null;
    this.setActive(true);
  }

  /** La niebla está calibrada para la cámara de juego: en la vista de revisión se apaga. */
  setActive(active: boolean): void {
    this.scene.fog = active ? this.fog : null;
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(active && this.fog ? this.fog.color : this.background);
    this.root.visible = active;
  }

  /** (x, y): el jugador en tiles; time: segundos. */
  update(x: number, y: number, time: number): void {
    if (!this.rain) return;
    const half = AREA / 2;
    for (let i = 0; i < DROPS; i++) {
      // Coordenada en la caja, "envuelta" alrededor del jugador.
      const gx = x - half + wrap(this.seeds[i * 3] * AREA - (x - half), AREA);
      const gz = y - half + wrap(this.seeds[i * 3 + 1] * AREA - (y - half), AREA);
      const gy = HEIGHT - wrap(this.seeds[i * 3 + 2] * HEIGHT + time * FALL_SPEED, HEIGHT);
      this.matrix.compose(this.pos.set(gx, gy, gz), this.tilt, this.scale);
      this.rain.setMatrixAt(i, this.matrix);
    }
    this.rain.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.setActive(false);
    if (this.rain) {
      this.rain.geometry.dispose();
      (this.rain.material as THREE.Material).dispose();
    }
  }
}

/** Módulo siempre positivo. */
function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}
