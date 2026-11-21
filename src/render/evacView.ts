// Dibuja las salidas: el helicóptero en la plaza, un camión militar en cada salida por
// carretera y un anillo en el suelo que se llena mientras aguantas en la zona.
// Cuando una salida se va (o escapas por ella), el vehículo se aleja.

import * as THREE from 'three';
import type { GameState } from '../game/state';
import type { EvacPoint } from '../world/evacuation';

/** Altura a la que espera el helicóptero y segundos que tarda en bajar. */
const HELI_HOVER = 26;
const HELI_DESCENT = 10;

interface Vehicle {
  point: EvacPoint;
  group: THREE.Group;
  rotor?: THREE.Object3D;
  ring: THREE.Mesh;
  fill: THREE.Mesh;
  fillMaterial: THREE.MeshBasicMaterial;
  /** Segundos desde que empezó a irse (-1 = sigue ahí). */
  leaving: number;
  /** Dirección hacia afuera de la ciudad (para el camión). */
  outX: number;
  outY: number;
}

export class EvacView {
  readonly root = new THREE.Group();
  private readonly vehicles: Vehicle[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  constructor(points: readonly EvacPoint[], gridSize: number, private readonly beacons: THREE.Mesh[]) {
    // Las columnas de luz pueden venir grises de la partida anterior: les devolvemos su color.
    points.forEach((point, i) => {
      const beacon = beacons[i];
      if (beacon) (beacon.material as THREE.MeshBasicMaterial).color.setHex(point.kind === 'helicopter' ? 0xf2c94c : 0xff4d4d);
    });
    for (const point of points) {
      const group = point.kind === 'helicopter' ? this.helicopter() : this.truck();
      group.position.set(point.x, 0, point.y);
      // El camión mira hacia afuera de la ciudad (hacia el borde más cercano).
      const center = gridSize / 2;
      let outX = 0;
      let outY = 0;
      if (Math.abs(point.x - center) > Math.abs(point.y - center)) outX = Math.sign(point.x - center);
      else outY = Math.sign(point.y - center);
      if (point.kind === 'road') {
        group.rotation.y = -Math.atan2(outY, outX);
        // Estacionado justo al borde, sin tapar la zona.
        group.position.x += outX * 1.2;
        group.position.z += outY * 1.2;
      }
      this.root.add(group);

      const ringGeometry = new THREE.RingGeometry(point.radius - 0.15, point.radius, 48);
      ringGeometry.rotateX(-Math.PI / 2);
      const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x9dff9d, transparent: true, opacity: 0.5, depthWrite: false });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.position.set(point.x, 0.12, point.y);
      this.root.add(ring);

      const fillGeometry = new THREE.CircleGeometry(point.radius - 0.15, 48);
      fillGeometry.rotateX(-Math.PI / 2);
      const fillMaterial = new THREE.MeshBasicMaterial({ color: 0x9dff9d, transparent: true, opacity: 0.18, depthWrite: false });
      const fill = new THREE.Mesh(fillGeometry, fillMaterial);
      fill.position.set(point.x, 0.11, point.y);
      fill.scale.setScalar(0.001);
      this.root.add(fill);
      this.disposables.push(ringGeometry, ringMaterial, fillGeometry, fillMaterial);

      const rotor = group.getObjectByName('rotor') ?? undefined;
      this.vehicles.push({ point, group, rotor, ring, fill, fillMaterial, leaving: -1, outX, outY });
    }
  }

  update(state: GameState, dt: number, time: number): void {
    const escape = state.escape;
    for (const v of this.vehicles) {
      const i = v.point.index;
      const gone = escape.departed[i] || escape.escapedVia === i;
      if (gone && v.leaving < 0) v.leaving = 0;

      const defense = escape.defense?.exit === i ? escape.defense : null;
      if (v.rotor) v.rotor.rotation.y += dt * (v.leaving >= 0 || defense ? 28 : 9);
      // El helicóptero no está esperando: da vueltas alto sobre la ciudad hasta que lo llamas y
      // baja en los últimos segundos de la defensa (aterriza justo cuando está listo).
      if (v.point.kind === 'helicopter' && v.leaving < 0) {
        const descent = defense ? (defense.ready ? 0 : Math.min(1, defense.timer / HELI_DESCENT)) : 1;
        const orbit = time * 0.25;
        v.group.position.set(
          v.point.x + Math.cos(orbit) * 14 * descent,
          HELI_HOVER * descent,
          v.point.y + Math.sin(orbit) * 14 * descent,
        );
      }

      if (v.leaving >= 0) {
        v.leaving += dt;
        const t = v.leaving;
        if (v.point.kind === 'helicopter') {
          // Se va desde donde esté (aterrizado si escapaste; volando si se fue sin ti).
          v.group.position.y = Math.min(60, v.group.position.y + dt * (2 + t * 6));
          v.group.position.x += dt * (1 + t * 3);
        } else {
          v.group.position.x = v.point.x + v.outX * (1.2 + t * t * 4);
          v.group.position.z = v.point.y + v.outY * (1.2 + t * t * 4);
        }
        v.group.visible = t < 12;
        v.ring.visible = false;
        v.fill.visible = false;
        // La columna de luz se apaga a gris.
        const beacon = this.beacons[i];
        if (beacon) (beacon.material as THREE.MeshBasicMaterial).color.setHex(0x555555);
        continue;
      }

      // Anillo que late, y relleno que crece con el avance de la espera.
      const pulse = 0.35 + 0.25 * Math.sin(time * 4);
      (v.ring.material as THREE.MeshBasicMaterial).opacity = pulse;
      const p = escape.progress[i];
      v.fill.scale.setScalar(Math.max(0.001, p));
      v.fillMaterial.opacity = 0.15 + 0.25 * p;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private mesh(geometry: THREE.BufferGeometry, color: number, x: number, y: number, z: number): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 });
    this.disposables.push(geometry, material);
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  }

  private helicopter(): THREE.Group {
    const g = new THREE.Group();
    const olive = 0x4e5a3a;
    g.add(this.mesh(new THREE.BoxGeometry(3.2, 1.4, 1.6), olive, 0, 1.0, 0));
    g.add(this.mesh(new THREE.BoxGeometry(1.0, 0.9, 1.4), 0x2a3340, 1.9, 1.05, 0)); // cabina
    g.add(this.mesh(new THREE.BoxGeometry(3.2, 0.35, 0.35), olive, -3.0, 1.35, 0)); // cola
    g.add(this.mesh(new THREE.BoxGeometry(0.2, 0.9, 0.2), olive, -4.5, 1.7, 0));
    g.add(this.mesh(new THREE.BoxGeometry(3.4, 0.1, 0.15), 0x222222, 0, 0.2, 0.75)); // patines
    g.add(this.mesh(new THREE.BoxGeometry(3.4, 0.1, 0.15), 0x222222, 0, 0.2, -0.75));
    const rotor = new THREE.Group();
    rotor.name = 'rotor';
    rotor.position.set(0, 1.95, 0);
    rotor.add(this.mesh(new THREE.BoxGeometry(7.5, 0.06, 0.3), 0x1a1a1a, 0, 0, 0));
    rotor.add(this.mesh(new THREE.BoxGeometry(0.3, 0.06, 7.5), 0x1a1a1a, 0, 0, 0));
    g.add(rotor);
    g.rotation.y = Math.PI / 5;
    return g;
  }

  private truck(): THREE.Group {
    const g = new THREE.Group();
    const olive = 0x56603f;
    g.add(this.mesh(new THREE.BoxGeometry(1.2, 1.2, 1.7), olive, 1.4, 0.9, 0)); // cabina
    g.add(this.mesh(new THREE.BoxGeometry(2.6, 1.5, 1.8), 0x6b7450, -0.6, 1.05, 0)); // caja
    for (const [x, z] of [
      [1.4, 0.85],
      [1.4, -0.85],
      [-1.2, 0.85],
      [-1.2, -0.85],
    ]) {
      g.add(this.mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12).rotateX(Math.PI / 2), 0x111111, x, 0.35, z));
    }
    return g;
  }
}
