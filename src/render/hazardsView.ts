// Dibujo del estado dinámico de hazards.ts: charcos de fuego y de ácido, señuelos (petardos,
// radio, alarma, bengala) y el suministro aéreo que baja en paracaídas.
//
// Todo con InstancedMesh y materiales aditivos: el fuego y el ácido BRILLAN (se ven en la
// oscuridad sin necesitar luces de verdad, que en Three.js obligan a recompilar los shaders
// cada vez que cambia cuántas hay). Las llamas que suben son chispas de effectsView.

import * as THREE from 'three';
import { DROP_DESCENT } from '../game/hazards';
import type { GameState } from '../game/state';
import type { EffectsView } from './effectsView';

const MAX_HAZARDS = 40;
const MAX_LURES = 16;
const MAX_DROPS = 4;
/** Bolsas que sueltan los zombies (ver game/pickups.ts). */
const MAX_PICKUPS = 60;
/** Altura desde la que se ve caer el suministro. */
const DROP_HEIGHT = 22;

export class HazardsView {
  readonly root = new THREE.Group();
  private readonly pools: THREE.InstancedMesh;
  private readonly cores: THREE.InstancedMesh;
  private readonly lures: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly glows: THREE.InstancedMesh;
  private readonly crates: THREE.InstancedMesh;
  private readonly chutes: THREE.InstancedMesh;
  private readonly bags: THREE.InstancedMesh;
  private readonly bagGlows: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private emberClock = 0;

  constructor(private readonly effects: EffectsView) {
    const disc = new THREE.CircleGeometry(1, 28);
    disc.rotateX(-Math.PI / 2);
    const glow = (opacity: number) =>
      new THREE.MeshBasicMaterial({ transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    // Dos discos por charco: uno ancho y tenue, otro chico y brillante que tiembla.
    this.pools = new THREE.InstancedMesh(disc, glow(0.45), MAX_HAZARDS);
    this.cores = new THREE.InstancedMesh(disc, glow(0.7), MAX_HAZARDS);
    // Señuelos: una cajita en el suelo con una luz que parpadea arriba.
    this.lures = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, 0.2, 0.25), new THREE.MeshStandardMaterial({ roughness: 0.6 }), MAX_LURES);
    this.lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 8, 6), glow(1), MAX_LURES);
    // El resplandor rojo de la bengala en el suelo (y del suministro sin abrir).
    this.glows = new THREE.InstancedMesh(disc, glow(0.35), MAX_LURES + MAX_DROPS);
    this.crates = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.1, 0.8, 1.1).translate(0, 0.4, 0),
      new THREE.MeshStandardMaterial({ color: 0x4a5a34, roughness: 0.8 }),
      MAX_DROPS,
    );
    const chute = new THREE.SphereGeometry(1.6, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    chute.translate(0, 2.2, 0);
    this.chutes = new THREE.InstancedMesh(chute, new THREE.MeshStandardMaterial({ color: 0xd8d0c0, roughness: 0.9, side: THREE.DoubleSide }), MAX_DROPS);
    // Lo que sueltan los zombies: una bolsita con un brillo tenue debajo para que se vea de noche.
    this.bags = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.34, 0.22, 0.26).translate(0, 0.11, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.7, emissive: 0x332200, emissiveIntensity: 0.6 }),
      MAX_PICKUPS,
    );
    this.bagGlows = new THREE.InstancedMesh(disc, glow(0.3), MAX_PICKUPS);
    for (const mesh of [this.pools, this.cores, this.lures, this.lights, this.glows, this.crates, this.chutes, this.bags, this.bagGlows]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.setColorAt(0, this.color.setHex(0xffffff));
    }
    this.crates.castShadow = true;
    this.root.add(this.pools, this.cores, this.lures, this.lights, this.glows, this.crates, this.chutes, this.bags, this.bagGlows);
  }

  update(state: GameState, time: number, dt: number): void {
    this.quaternion.identity();
    let pools = 0;
    for (const h of state.hazards) {
      if (pools >= MAX_HAZARDS) break;
      const fire = h.kind === 'fire';
      // Al final se apaga: el radio ya lo achica la lógica; acá además baja el brillo.
      const life = Math.min(1, h.timer / 1.5);
      // El ácido burbujea: el centro late rápido y brilla (antes era un verde quieto que se perdía).
      const flicker = fire ? 0.85 + 0.15 * Math.sin(time * 17 + h.x * 3) : 0.75 + 0.25 * Math.sin(time * 9 + h.y * 2);
      // Un poco por encima de la vereda y la plaza (0,15): si no, el charco quedaba escondido abajo.
      this.place(this.pools, pools, h.x, 0.17, h.y, h.radius, fire ? 0xff5a10 : 0x7af020, life);
      this.place(this.cores, pools, h.x, 0.175, h.y, h.radius * 0.6 * flicker, fire ? 0xffb040 : 0xd8ff70, life);
      pools++;
    }

    let lures = 0;
    let glows = 0;
    for (const lure of state.lures) {
      if (lures >= MAX_LURES) break;
      const colors: Record<string, [number, number]> = {
        firecracker: [0xa02020, 0xffd040],
        radio: [0x3a3e44, 0x40ff60],
        alarm: [0x000000, 0xff8a20],
        flare: [0xb02a20, 0xff3020],
      };
      const [body, light] = colors[lure.kind];
      // La alarma es el auto mismo: solo la luz (los faros que parpadean).
      if (lure.kind !== 'alarm') this.place(this.lures, lures, lure.x, 0.1, lure.y, 1, body, 1);
      else this.place(this.lures, lures, lure.x, -5, lure.y, 0, body, 1);
      const blink = lure.kind === 'flare' ? 1 : Math.sin(time * (lure.kind === 'firecracker' ? 30 : 6)) > 0 ? 1 : 0;
      this.place(this.lights, lures, lure.x, lure.kind === 'alarm' ? 1.1 : 0.35, lure.y, blink * (lure.kind === 'alarm' ? 2.5 : 1), light, 1);
      if (lure.kind === 'flare' && glows < MAX_LURES) {
        this.place(this.glows, glows++, lure.x, 0.04, lure.y, 3.2 + 0.4 * Math.sin(time * 9), 0xff2a10, 1);
      }
      lures++;
    }

    let drops = 0;
    for (const d of state.drops) {
      if (drops >= MAX_DROPS) break;
      // Baja solo en los últimos DROP_DESCENT segundos (antes, es el avión que se oye llegar).
      if (d.fall > DROP_DESCENT) continue;
      const falling = d.fall > 0;
      const height = falling ? (d.fall / DROP_DESCENT) * DROP_HEIGHT : 0;
      const sway = falling ? Math.sin(time * 1.5) * 0.15 : 0;
      this.quaternion.setFromAxisAngle(this.axis, sway);
      this.place(this.crates, drops, d.x, height, d.y, 1, d.opened ? 0x2e3622 : 0x4a5a34, 1);
      this.place(this.chutes, drops, d.x, falling ? height : -50, d.y, 1, 0xd8d0c0, 1);
      this.quaternion.identity();
      if (!d.opened && glows < MAX_LURES + MAX_DROPS) {
        // Humo de señal verde en el suelo donde va a caer (y donde está, hasta abrirlo).
        this.place(this.glows, glows++, d.x, 0.04, d.y, 1.6 + 0.2 * Math.sin(time * 4), 0x30ff60, 0.7);
      }
      drops++;
    }

    let bags = 0;
    for (const b of state.pickups) {
      if (bags >= MAX_PICKUPS) break;
      // El botín de jefe es más grande y dorado; late para que se note.
      const pulse = 0.8 + 0.2 * Math.sin(time * 4 + b.x);
      this.quaternion.setFromAxisAngle(this.up, b.x * 7 + b.y * 3);
      this.place(this.bags, bags, b.x, 0, b.y, b.big ? 2 : 1, b.big ? 0xd8a630 : 0x8a7a50, 1);
      this.quaternion.identity();
      this.place(this.bagGlows, bags, b.x, 0.03, b.y, (b.big ? 1.4 : 0.55) * pulse, b.big ? 0xffc040 : 0xffe0a0, b.big ? 0.9 : 0.5);
      bags++;
    }
    this.finish(this.bags, bags);
    this.finish(this.bagGlows, bags);

    this.finish(this.pools, pools);
    this.finish(this.cores, pools);
    this.finish(this.lures, lures);
    this.finish(this.lights, lures);
    this.finish(this.glows, glows);
    this.finish(this.crates, drops);
    this.finish(this.chutes, drops);

    // Llamas que suben: de los charcos de fuego y de los zombies que arden (unas 40 por segundo
    // en total como mucho, repartidas).
    this.emberClock += dt;
    while (this.emberClock > 1 / 40) {
      this.emberClock -= 1 / 40;
      const fires = state.hazards.filter((h) => h.kind === 'fire');
      if (fires.length > 0 && Math.random() < 0.6) {
        const h = fires[Math.floor(Math.random() * fires.length)];
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * h.radius;
        this.effects.ember(h.x + Math.cos(a) * r, h.y + Math.sin(a) * r, 0.1);
      }
      const burning = state.zombies.filter((z) => z.burn > 0 && z.hp > 0);
      if (burning.length > 0) {
        const z = burning[Math.floor(Math.random() * burning.length)];
        this.effects.ember(z.x, z.y, 0.6 + Math.random() * 0.9);
      }
    }
  }

  private readonly axis = new THREE.Vector3(1, 0, 0);
  private readonly up = new THREE.Vector3(0, 1, 0);

  private place(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, s: number, color: number, brightness: number): void {
    this.position.set(x, y, z);
    this.scale.set(s, mesh === this.lures || mesh === this.crates || mesh === this.chutes || mesh === this.bags ? s : 1, s);
    if (mesh === this.lights) this.scale.set(s, s, s);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    mesh.setMatrixAt(index, this.matrix);
    mesh.setColorAt(index, this.color.setHex(color).multiplyScalar(brightness));
  }

  private finish(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.pools, this.cores, this.lures, this.lights, this.glows, this.crates, this.chutes, this.bags, this.bagGlows]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
