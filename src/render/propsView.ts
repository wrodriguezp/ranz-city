// Dibuja autos, cajas y cuerpos, más un pequeño destello sobre lo que todavía no revisaste.
//
// Son estáticos (salen de la seed), así que las matrices se calculan una sola vez. Lo que cambia:
//  - el destello: se apaga al revisar y solo se ve a media distancia, para que en la oscuridad
//    haya que acercarse y arriesgarse para encontrar loot;
//  - un anillo en el suelo alrededor del contenedor más cercano: "con esto puedes interactuar";
//  - un arco que se va llenando mientras lo registras (además de la barra del HUD).

import * as THREE from 'three';
import { SEARCH_RANGE, searchableNear } from '../game/loot';
import type { GameState } from '../game/state';
import type { Container } from '../world/props';

// Los dos últimos son la ambulancia (blanca) y el camión militar (oliva): ver CAR_AMBULANCE.
const CAR_COLORS = [0x7a2e2e, 0x2e4a7a, 0x8a8a8a, 0x2f2f33, 0x6b6b3a, 0xcfcfcf, 0xe8e8e8, 0x3f4a2a];
const BODY_COLORS = [0x4f5d6e, 0x6e5a4a, 0x4a6e52, 0x705070];
const GLINT_DISTANCE = 16;
/** Desde esta distancia aparece el anillo (tenue); al alcance de E, brillante. */
const HIGHLIGHT_DISTANCE = 4;

export class PropsView {
  readonly root = new THREE.Group();
  private readonly glints: THREE.InstancedMesh;
  private readonly glintOwners: number[] = [];
  private readonly highlight: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly progressArc: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private arcStep = -1;
  private readonly matrix = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(
    private readonly containers: readonly Container[],
    /** Autos que se están quemando: carrocería carbonizada. */
    burnt: ReadonlySet<number> = new Set(),
  ) {
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
      bodyMesh.setColorAt(i, new THREE.Color(burnt.has(c.id) ? 0x1a1714 : CAR_COLORS[c.variant % CAR_COLORS.length]));
    });

    // Cajas de madera (las de la plaza, verdes y militares).
    const crateGeometry = this.box(0.85, 0.8, 0.85, 0.4);
    const crateMesh = this.instanced(crateGeometry, this.material(new THREE.MeshStandardMaterial({ roughness: 0.85 })), crates.length);
    crates.forEach((c, i) => {
      crateMesh.setMatrixAt(i, this.compose(c.x + 0.5, 0.15, c.y + 0.5, c.angle));
      // Militar (oliva), médica (blanca) o común (madera).
      crateMesh.setColorAt(i, new THREE.Color(c.variant === 1 ? 0x4b5a32 : c.variant === 2 ? 0xd8d8d8 : 0x8a6a3e));
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
    const glintGeometry = new THREE.OctahedronGeometry(0.22);
    this.geometries.push(glintGeometry);
    this.glints = this.instanced(
      glintGeometry,
      this.material(new THREE.MeshBasicMaterial({ color: 0xffd25a, transparent: true, opacity: 0.85 })),
      containers.length,
    );
    this.glints.castShadow = false;
    for (const c of containers) this.glintOwners.push(c.id);

    // Anillo de "puedes interactuar" y arco de progreso: acostados en el suelo.
    const flat = { transparent: true, depthWrite: false, side: THREE.DoubleSide } as const;
    this.highlight = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffd25a, ...flat }));
    this.progressArc = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.9, 40, 1, 0, 0.01), new THREE.MeshBasicMaterial({ color: 0x8fff8f, ...flat }));
    for (const mesh of [this.highlight, this.progressArc]) {
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.root.add(mesh);
      this.geometries.push(mesh.geometry);
      this.materials.push(mesh.material);
    }
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
    this.updateHighlight(state, time);
  }

  private updateHighlight(state: GameState, time: number): void {
    const searching = state.loot.target;
    const target = searching >= 0 ? searching : searchableNear(state, this.containers, HIGHLIGHT_DISTANCE);
    this.highlight.visible = target >= 0;
    this.progressArc.visible = searching >= 0;
    if (target < 0) return;
    const c = this.containers[target];
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    // El anillo rodea al contenedor: un auto (3 × 2) necesita uno más grande que una caja.
    const radius = Math.max(c.w, c.h) * 0.6 + 0.4;
    const inRange = searching >= 0 || searchableNear(state, this.containers, SEARCH_RANGE) === target;
    this.highlight.position.set(cx, 0.05, cy);
    this.highlight.scale.setScalar(radius * (inRange ? 1 + Math.sin(time * 6) * 0.04 : 1));
    this.highlight.material.opacity = inRange ? 0.85 : 0.3;

    if (searching >= 0) {
      // Rehacer la geometría del arco solo cuando avanza un "paso" (de 48): es barato y suficiente.
      const step = Math.round(state.loot.progress * 48);
      if (step !== this.arcStep) {
        this.arcStep = step;
        this.progressArc.geometry.dispose();
        this.progressArc.geometry = new THREE.RingGeometry(0.75, 0.92, 40, 1, Math.PI / 2, -Math.max(0.01, (step / 48) * Math.PI * 2));
        this.geometries.push(this.progressArc.geometry);
      }
      this.progressArc.position.set(cx, 0.06, cy);
      this.progressArc.scale.setScalar(radius);
      this.progressArc.material.opacity = 0.95;
    } else {
      this.arcStep = -1;
    }
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
