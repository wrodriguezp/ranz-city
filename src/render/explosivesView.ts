// Dibujo de barriles explosivos y de lo que vuela (granadas y rocas del tanque).
//
// Los barriles son estáticos: se escriben una vez y se reescriben solo cuando alguno explota
// (state.barrelsBlown cambia). Las granadas llevan una lucecita roja que parpadea más rápido
// a medida que se acaba la mecha: es la forma de "leer" cuánto falta para que reviente.
//
// La roca del tanque se telegrafía en dos tiempos: mientras carga el tiro, la roca se ve sobre su
// cabeza (subiendo); cuando vuela, un anillo rojo que late marca en el suelo dónde va a caer.
// El ácido del escupidor usa el mismo anillo, en verde.
//
// Los demás lanzables (molotov, petardos, radio, bengala, cohete) comparten la malla de la granada
// con un color por instancia; el cohete se estira y se orienta hacia donde vuela.

import * as THREE from 'three';
import type { GameState } from '../game/state';
import type { Barrel } from '../world/props';

const MAX_PROJECTILES = 24;
const PROJECTILE_COLOR: Record<string, number> = {
  grenade: 0x3d5232,
  molotov: 0x7a5a20,
  firecracker: 0xc02020,
  radio: 0x404448,
  flare: 0xd03020,
  rocket: 0x55603a,
  acid: 0x9ade40,
};
/** Color de la lucecita: la mecha de la granada, el trapo encendido del molotov, la bengala. */
const BLINK_COLOR: Record<string, number> = {
  grenade: 0xff2a2a,
  molotov: 0xff9a20,
  firecracker: 0xffd040,
  radio: 0x40ff60,
  flare: 0xff3020,
  rocket: 0xffb040,
};

export class ExplosivesView {
  readonly root = new THREE.Group();
  private readonly barrels: THREE.InstancedMesh;
  private readonly bands: THREE.InstancedMesh;
  private readonly grenades: THREE.InstancedMesh;
  private readonly blinks: THREE.InstancedMesh;
  private readonly rocks: THREE.InstancedMesh;
  private readonly markers: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();
  private blownSeen = -1;

  constructor(private readonly list: readonly Barrel[]) {
    const body = new THREE.CylinderGeometry(0.34, 0.34, 1.0, 14);
    body.translate(0, 0.5, 0);
    this.barrels = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.55, metalness: 0.3 }), Math.max(1, list.length));
    // Una franja amarilla brillante: se distingue en la oscuridad apenas la toca la linterna.
    const band = new THREE.CylinderGeometry(0.35, 0.35, 0.12, 14);
    band.translate(0, 0.72, 0);
    this.bands = new THREE.InstancedMesh(band, new THREE.MeshStandardMaterial({ color: 0xffd23a, emissive: 0x3a2a00, roughness: 0.4 }), Math.max(1, list.length));
    for (const mesh of [this.barrels, this.bands]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = list.length;
    }

    this.grenades = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshStandardMaterial({ roughness: 0.6 }), MAX_PROJECTILES);
    this.blinks = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.07, 6, 5),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_PROJECTILES,
    );
    this.grenades.setColorAt(0, this.color.setHex(0xffffff));
    this.blinks.setColorAt(0, this.color.setHex(0xffffff));
    this.rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.45), new THREE.MeshStandardMaterial({ color: 0x5c5a55, roughness: 1 }), MAX_PROJECTILES);
    for (const mesh of [this.grenades, this.blinks, this.rocks]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
    }
    this.rocks.castShadow = true;
    const ring = new THREE.RingGeometry(1.1, 1.45, 36);
    ring.rotateX(-Math.PI / 2);
    this.markers = new THREE.InstancedMesh(
      ring,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_PROJECTILES,
    );
    this.markers.setColorAt(0, this.color.setHex(0xffffff));
    this.markers.count = 0;
    this.markers.frustumCulled = false;
    this.root.add(this.barrels, this.bands, this.grenades, this.blinks, this.rocks, this.markers);
  }

  update(state: GameState, time: number): void {
    this.updateBarrels(state);

    let grenades = 0;
    let rocks = 0;
    let blinks = 0;
    let markers = 0;
    // Tanques cargando el tiro: la roca arriba de la cabeza, sube mientras carga.
    for (const z of state.zombies) {
      if (z.kind !== 'tank' || z.mode !== 'throw' || z.hp <= 0 || rocks >= MAX_PROJECTILES) continue;
      const lift = Math.min(1, 1 - z.timer / 1.25);
      this.euler.set(0, time * 2, 0);
      this.quaternion.setFromEuler(this.euler);
      this.position.set(z.x, 2.2 + lift * 1.6, z.y);
      this.scale.setScalar(0.6 + lift * 0.4);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.scale.setScalar(1);
      this.rocks.setMatrixAt(rocks++, this.matrix);
    }
    for (const p of state.projectiles) {
      const rocket = p.kind === 'rocket';
      if (rocket) {
        // El cohete apunta hacia donde vuela (no gira como lo que se lanza a mano).
        this.euler.set(0, -Math.atan2(p.vy, p.vx), 0);
        this.scale.set(3.2, 0.8, 0.8);
      } else {
        this.euler.set(time * 9, time * 7, 0);
      }
      this.quaternion.setFromEuler(this.euler);
      this.position.set(p.x, p.z + (p.kind === 'rock' ? 0.45 : 0.16), p.y);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.scale.set(1, 1, 1);
      if (p.kind === 'rock' || p.kind === 'acid') {
        if (p.kind === 'rock' && rocks < MAX_PROJECTILES) this.rocks.setMatrixAt(rocks++, this.matrix);
        if (p.kind === 'acid' && grenades < MAX_PROJECTILES) {
          this.grenades.setColorAt(grenades, this.color.setHex(PROJECTILE_COLOR.acid));
          this.grenades.setMatrixAt(grenades++, this.matrix);
        }
        if (!p.landed && markers < MAX_PROJECTILES) {
          // El anillo se cierra y late más rápido a medida que la roca (o el ácido) baja.
          const near = Math.max(0, Math.min(1, 1 - p.z / 6));
          const pulse = 1 + 0.12 * Math.sin(time * (10 + near * 14));
          this.position.set(p.targetX, 0.06, p.targetY);
          this.quaternion.identity();
          this.scale.setScalar((p.kind === 'acid' ? 1.2 : 1.25 - near * 0.35) * pulse);
          this.matrix.compose(this.position, this.quaternion, this.scale);
          this.scale.setScalar(1);
          this.markers.setColorAt(markers, this.color.setHex(p.kind === 'acid' ? 0x9cff40 : 0xff3020));
          this.markers.setMatrixAt(markers++, this.matrix);
        }
        continue;
      }
      if (grenades >= MAX_PROJECTILES) continue;
      this.grenades.setColorAt(grenades, this.color.setHex(PROJECTILE_COLOR[p.kind] ?? 0x3d5232));
      this.grenades.setMatrixAt(grenades++, this.matrix);
      // Parpadeo: la granada de 3 a 14 veces por segundo según lo que queda de mecha; el resto
      // (trapo encendido, bengala, cohete) brilla fijo.
      const rate = p.kind === 'grenade' ? 3 + 11 * Math.max(0, 1 - p.fuse / 1.7) : 0;
      if (blinks < MAX_PROJECTILES && (rate === 0 || Math.sin(time * rate * Math.PI * 2) > 0)) {
        if (rocket) this.matrix.makeTranslation(p.x - Math.cos(Math.atan2(p.vy, p.vx)) * 0.55, p.z + 0.16, p.y - Math.sin(Math.atan2(p.vy, p.vx)) * 0.55);
        else this.matrix.makeTranslation(p.x, p.z + 0.34, p.y);
        this.blinks.setColorAt(blinks, this.color.setHex(BLINK_COLOR[p.kind] ?? 0xff2a2a));
        this.blinks.setMatrixAt(blinks++, this.matrix);
      }
    }
    for (const mesh of [this.grenades, this.blinks, this.markers]) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const [mesh, count] of [
      [this.grenades, grenades],
      [this.rocks, rocks],
      [this.blinks, blinks],
      [this.markers, markers],
    ] as const) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private updateBarrels(state: GameState): void {
    const blown = state.barrelsBlown.reduce((n, b) => n + (b ? 1 : 0), 0);
    if (blown === this.blownSeen) return;
    this.blownSeen = blown;
    this.list.forEach((barrel, i) => {
      if (state.barrelsBlown[i]) {
        this.barrels.setMatrixAt(i, this.hidden);
        this.bands.setMatrixAt(i, this.hidden);
        return;
      }
      this.matrix.makeTranslation(barrel.x + 0.5, 0, barrel.y + 0.5);
      this.barrels.setMatrixAt(i, this.matrix);
      this.bands.setMatrixAt(i, this.matrix);
    });
    this.barrels.instanceMatrix.needsUpdate = true;
    this.bands.instanceMatrix.needsUpdate = true;
    this.barrels.computeBoundingSphere();
    this.bands.computeBoundingSphere();
  }

  dispose(): void {
    for (const mesh of [this.barrels, this.bands, this.grenades, this.blinks, this.rocks, this.markers]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
