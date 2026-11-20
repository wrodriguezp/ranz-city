// Dibuja autos, cajas y cuerpos, más un pequeño destello sobre lo que todavía no revisaste.
//
// Son estáticos (salen de la seed), así que las matrices se calculan una sola vez. Lo único
// que cambia es el destello: se apaga al revisar y solo se ve de cerca, para que en la
// oscuridad haya que acercarse y arriesgarse para encontrar loot.

import * as THREE from 'three';
import type { GameState } from '../game/state';
import type { Container } from '../world/props';

const CAR_COLORS = [0x7a2e2e, 0x2e4a7a, 0x8a8a8a, 0x2f2f33, 0x6b6b3a, 0xcfcfcf];
const BODY_COLORS = [0x4f5d6e, 0x6e5a4a, 0x4a6e52, 0x705070];
const GLINT_DISTANCE = 11;

export class PropsView {
  readonly root = new THREE.Group();
  private readonly glints: THREE.InstancedMesh;
  private readonly glintOwners: number[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(private readonly containers: readonly Container[]) {
    const cars = containers.filter((c) => c.kind === 'car');
    const crates = containers.filter((c) => c.kind === 'crate');
    const bodies = containers.filter((c) => c.kind === 'body');

    // Autos: carrocería + cabina, dos InstancedMesh con las mismas matrices.
    const carBody = this.box(2.8, 0.75, 1.7, 0.35);
    const carCabin = this.box(1.5, 0.55, 1.5, 1.05);
    carCabin.translate(-0.15, 0, 0);
    const paint = this.material(new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 }));
    const glass = this.material(new THREE.MeshStandardMaterial({ color: 0x1b222b, roughness: 0.15, metalness: 0.6 }));
    const bodyMesh = this.instanced(carBody, paint, cars.length);
    const cabinMesh = this.instanced(carCabin, glass, cars.length);
    cars.forEach((c, i) => {
      const m = this.compose(c.x + c.w / 2, 0, c.y + c.h / 2, -c.angle);
      bodyMesh.setMatrixAt(i, m);
      cabinMesh.setMatrixAt(i, m);
      bodyMesh.setColorAt(i, new THREE.Color(CAR_COLORS[c.variant % CAR_COLORS.length]));
    });

    // Cajas de madera (las de la plaza, verdes y militares).
    const crateGeometry = this.box(0.85, 0.8, 0.85, 0.4);
    const crateMesh = this.instanced(crateGeometry, this.material(new THREE.MeshStandardMaterial({ roughness: 0.85 })), crates.length);
    crates.forEach((c, i) => {
      crateMesh.setMatrixAt(i, this.compose(c.x + 0.5, 0.15, c.y + 0.5, c.angle));
      crateMesh.setColorAt(i, new THREE.Color(c.variant === 1 ? 0x4b5a32 : 0x8a6a3e));
    });

    // Cuerpos: una cápsula acostada.
    const corpse = new THREE.CapsuleGeometry(0.25, 1.0, 3, 8);
    corpse.rotateZ(Math.PI / 2);
    corpse.translate(0, 0.2, 0);
    this.geometries.push(corpse);
    const bodyCorpses = this.instanced(corpse, this.material(new THREE.MeshStandardMaterial({ roughness: 0.9 })), bodies.length);
    bodies.forEach((c, i) => {
      bodyCorpses.setMatrixAt(i, this.compose(c.x + 0.5, 0, c.y + 0.5, c.angle));
      bodyCorpses.setColorAt(i, new THREE.Color(BODY_COLORS[c.variant % BODY_COLORS.length]));
    });

    // Destellos: un rombito amarillo que flota. MeshBasic (no le afecta la luz): se ve en la oscuridad.
    const glintGeometry = new THREE.OctahedronGeometry(0.16);
    this.geometries.push(glintGeometry);
    this.glints = this.instanced(
      glintGeometry,
      this.material(new THREE.MeshBasicMaterial({ color: 0xffd25a, transparent: true, opacity: 0.85 })),
      containers.length,
    );
    this.glints.castShadow = false;
    for (const c of containers) this.glintOwners.push(c.id);
  }

  update(state: GameState, time: number): void {
    const { x, y } = state.player;
    const bob = Math.sin(time * 3) * 0.12;
    for (let i = 0; i < this.glintOwners.length; i++) {
      const c = this.containers[this.glintOwners[i]];
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      const visible = !state.loot.searched[c.id] && Math.hypot(cx - x, cy - y) < GLINT_DISTANCE;
      if (!visible) {
        this.glints.setMatrixAt(i, this.hidden);
        continue;
      }
      const height = c.kind === 'car' ? 1.9 : c.kind === 'crate' ? 1.5 : 0.9;
      this.matrix.makeRotationY(time * 2 + i);
      this.matrix.setPosition(cx, height + bob, cy);
      this.glints.setMatrixAt(i, this.matrix);
    }
    this.glints.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }

  private box(w: number, h: number, d: number, bottom: number): THREE.BufferGeometry {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, bottom + h / 2, 0);
    this.geometries.push(g);
    return g;
  }

  private material<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private instanced(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    mesh.count = count;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    return mesh;
  }

  private compose(x: number, y: number, z: number, angle: number): THREE.Matrix4 {
    return new THREE.Matrix4().makeRotationY(angle).setPosition(x, y, z);
  }
}
