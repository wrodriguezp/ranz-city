// Faroles en pantalla: los postes y los charcos de luz cálida que dejan en la calle.
//
// ¿Por qué no un PointLight por farol? Una ciudad tiene más de 100 faroles, y Three.js calcula
// TODAS las luces en cada píxel: con 100 luces el juego se arrastra. En cambio, la luz de los
// faroles no se mueve, así que la "horneamos" en una textura vista desde arriba (un texel cada
// medio tile, con la misma información que usa la lógica en world/streetLights.ts) y le
// inyectamos al shader estándar de Three.js una línea que la lee:
//
//   luz extra = color de la superficie · color del farol · valor de la textura en (x, z)
//
// Es muy barato (una lectura de textura por píxel) y lo que se ve coincide exactamente con lo
// que la lógica considera "iluminado". La luz se apaga con la altura: ilumina el suelo, los pies
// de los zombies y la parte baja de los edificios, como un farol de verdad.
//
// Los faroles que parpadean van en otro canal de la textura (g), multiplicado por uFlicker, que
// se calcula con la misma función lampFlicker(time) que la lógica.

import * as THREE from 'three';
import { lampFlicker, rasterizeLamps, type LightMap } from '../world/streetLights';

/** Texels por tile: 2 alcanza para que el borde del charco se vea suave. */
const TEXELS_PER_TILE = 2;
const LAMP_COLOR = new THREE.Color(0xffc477);
const POLE_HEIGHT = 4.4;
const BULB_COLOR = new THREE.Color(0xffe2a8);

/**
 * Uniforms compartidos por todos los materiales parchados. Son objetos únicos: al cambiar de
 * ciudad se reemplaza la textura y todos los materiales la ven sin recompilar nada.
 */
const uniforms = {
  uStreetLight: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) as THREE.Texture },
  uStreetSize: { value: new THREE.Vector2(1, 1) },
  uFlicker: { value: 1 },
  uStreetIntensity: { value: 1.5 },
  uStreetColor: { value: LAMP_COLOR },
};

const patched = new WeakSet<THREE.Material>();

/** Le agrega la luz de los faroles a un material estándar (una sola vez por material). */
export function addStreetLight(material: THREE.Material): void {
  if (!(material instanceof THREE.MeshStandardMaterial) || patched.has(material)) return;
  patched.add(material);
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSLWorld;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 slPos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          slPos = instanceMatrix * slPos;
        #endif
        vSLWorld = (modelMatrix * slPos).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vSLWorld;
        uniform sampler2D uStreetLight;
        uniform vec2 uStreetSize;
        uniform float uFlicker;
        uniform float uStreetIntensity;
        uniform vec3 uStreetColor;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          vec4 sl = texture2D(uStreetLight, vSLWorld.xz / uStreetSize);
          float slHeight = clamp(1.0 - vSLWorld.y / 6.0, 0.0, 1.0);
          float slAmount = (sl.r + sl.g * uFlicker) * slHeight;
          reflectedLight.directDiffuse += diffuseColor.rgb * uStreetColor * slAmount * uStreetIntensity;
        }`,
      );
  };
  // Todos los parchados comparten el mismo código: que Three.js no los confunda con los demás.
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|streetlight`;
  material.needsUpdate = true;
}

/** Parcha todos los materiales estándar que cuelgan de `root`. */
export function addStreetLightTo(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of list) addStreetLight(m);
  });
}

/** Encendido o apagado general (en la vista de revisión de día no hacen falta). */
export function setStreetLightIntensity(value: number): void {
  uniforms.uStreetIntensity.value = value;
}

export class StreetLightView {
  readonly root = new THREE.Group();
  private readonly texture: THREE.DataTexture;
  private readonly flickerBulbs: THREE.MeshBasicMaterial;
  private readonly flickerHalos: THREE.MeshBasicMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(map: LightMap) {
    // 1. La textura de luz, vista desde arriba.
    const cols = map.width * TEXELS_PER_TILE;
    const rows = map.height * TEXELS_PER_TILE;
    const steady = new Float32Array(cols * rows);
    const flicker = new Float32Array(cols * rows);
    rasterizeLamps(map.lamps, map.width, map.height, TEXELS_PER_TILE, steady, flicker);
    const data = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
      data[i * 4] = Math.round(steady[i] * 255);
      data[i * 4 + 1] = Math.round(flicker[i] * 255);
      data[i * 4 + 3] = 255;
    }
    this.texture = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    uniforms.uStreetLight.value = this.texture;
    uniforms.uStreetSize.value.set(map.width, map.height);

    // 2. Los postes: un cilindro y un brazo que cuelga hacia la calle. Instanciados (son 100+).
    const pole = new THREE.CylinderGeometry(0.08, 0.11, POLE_HEIGHT, 8);
    pole.translate(0, POLE_HEIGHT / 2, 0);
    const arm = new THREE.BoxGeometry(1.5, 0.08, 0.08);
    arm.translate(0.7, POLE_HEIGHT - 0.05, 0);
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.6, metalness: 0.4 });
    const bulb = new THREE.BoxGeometry(0.5, 0.12, 0.3);
    bulb.translate(1.4, POLE_HEIGHT - 0.14, 0);
    const halo = new THREE.SphereGeometry(0.75, 12, 8);
    halo.scale(1, 0.45, 1);
    halo.translate(1.4, POLE_HEIGHT - 0.3, 0);
    this.disposables.push(pole, arm, metal, bulb, halo, this.texture);

    const steadyLamps = map.lamps.filter((l) => !l.flicker);
    const flickerLamps = map.lamps.filter((l) => l.flicker);
    const bulbOn = new THREE.MeshBasicMaterial({ color: BULB_COLOR });
    const haloOn = new THREE.MeshBasicMaterial({ color: LAMP_COLOR, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
    this.flickerBulbs = bulbOn.clone();
    this.flickerHalos = haloOn.clone();
    this.disposables.push(bulbOn, haloOn, this.flickerBulbs, this.flickerHalos);

    const all = map.lamps;
    this.root.add(this.instanced(pole, metal, all, true), this.instanced(arm, metal, all, true));
    this.root.add(this.instanced(bulb, bulbOn, steadyLamps, false), this.instanced(halo, haloOn, steadyLamps, false));
    this.root.add(this.instanced(bulb, this.flickerBulbs, flickerLamps, false), this.instanced(halo, this.flickerHalos, flickerLamps, false));
  }

  private instanced(geometry: THREE.BufferGeometry, material: THREE.Material, lamps: LightMap['lamps'], shadow: boolean): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, lamps.length));
    mesh.count = lamps.length;
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Matrix4();
    lamps.forEach((lamp, i) => {
      // facing es un ángulo en el plano (x, y) del mundo lógico; en Three.js ese plano es (x, z),
      // y una rotación positiva en Y gira de x hacia -z: por eso el signo menos.
      rotation.makeRotationY(-lamp.facing);
      matrix.makeTranslation(lamp.x, 0, lamp.y).multiply(rotation);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.castShadow = shadow;
    mesh.computeBoundingSphere();
    this.disposables.push(mesh);
    return mesh;
  }

  /** Mismo parpadeo que la lógica: si la luz se apaga en pantalla, también deja de delatarte. */
  update(time: number): void {
    const f = lampFlicker(time);
    uniforms.uFlicker.value = f;
    this.flickerBulbs.color.copy(BULB_COLOR).multiplyScalar(0.15 + 0.85 * f);
    this.flickerHalos.opacity = 0.22 * f;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
