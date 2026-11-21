// Dibuja la ciudad en 3D leyendo la grilla de tiles.
//
// Convención de ejes: el mundo lógico es 2D (x, y en tiles). En Three.js el eje Y apunta
// hacia arriba, así que el tile (x, y) se dibuja en la posición 3D (x, altura, y).
// 1 tile = 1 unidad de Three.js.
//
// Rendimiento: hay ~150 edificios y decenas de barricadas. En vez de crear un Mesh por cada uno
// (una llamada de dibujo por objeto) usamos InstancedMesh: una sola geometría de caja que la GPU
// dibuja muchas veces, cada copia con su propia matriz (posición/escala) y color.
// Es la misma técnica que usaremos para los cientos de zombies del hito 4.

import * as THREE from 'three';
import type { City } from '../world/city';
import { Rng } from '../world/rng';
import { buildingHeight, nodeCenter, SIDEWALK_WIDTH, type Building, type Rect } from '../world/tileGrid';
import { buildBlocksView } from './blocksView';

const COLORS = {
  ground: 0x2b2e34,
  sidewalk: 0x5a5f66,
  plaza: 0x46523f,
  barricade: 0xd9822b,
  start: 0x3ddc84,
  exit: 0xff4d4d,
  helipad: 0xf2c94c,
  wall: 0x1a1c20,
};

const BUILDING_PALETTE = [0x8a8f98, 0x9c8f80, 0x7d8a8c, 0xa39a8b, 0x6f7680, 0x8c7f75];
/** Casas en colores pastel gastados; el hospital blanco; la tienda roja; las carpas oliva. */
const HOUSE_PALETTE = [0xb9a98a, 0x9fb0a4, 0xc2a38f, 0xa7a2b8, 0xc9c0a0, 0x8fa3b5];
const STYLE_COLOR: Record<string, number> = { hospital: 0xd5d9dc, shop: 0xa8443a, tent: 0x4b5a32 };

const SIDEWALK_HEIGHT = 0.15;

export interface CityView {
  root: THREE.Group;
  /** Capa de depuración con el grafo (cruces coloreados por distancia y tramos abiertos). */
  graphOverlay: THREE.Group;
  /** Columna de luz de cada salida (índice = layout.exits); se apagan cuando la salida se va. */
  exitBeacons: THREE.Mesh[];
  /**
   * Vuelve semitransparentes los edificios que tapan al jugador.
   * toCamera: dirección (normalizada) desde la escena hacia la cámara. Sin argumentos, no oculta ninguno.
   */
  updateOcclusion(playerX?: number, playerY?: number, toCamera?: THREE.Vector3): void;
  /** Animaciones del escenario (fogatas). */
  update(time: number, playerX?: number, playerY?: number): void;
  dispose(): void;
}

const BUILDING_INSET = 0.12;
/** Valor que los edificios escriben en el stencil. */
export const BUILDING_STENCIL = 1;

export function buildCityView(city: City): CityView {
  const root = new THREE.Group();
  const { grid } = city;
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  // Movemos la caja para que su base quede en y=0: así escalar en altura la "levanta" desde el suelo.
  unitBox.translate(0, 0.5, 0);

  // Suelo (asfalto) que cubre toda la ciudad.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(grid.width, grid.height),
    new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(grid.width / 2, 0, grid.height / 2);
  ground.receiveShadow = true;
  root.add(ground);

  // Veredas: una losa por manzana. Los edificios se apoyan encima y tapan el centro.
  const sidewalks = instancedBoxes(unitBox, grid.blocks.filter((b) => b.kind !== 'canal'), () => SIDEWALK_HEIGHT, () => COLORS.sidewalk);
  sidewalks.receiveShadow = true;
  root.add(sidewalks);

  // Edificios: altura = pisos × FLOOR_HEIGHT. Se achican un poco (inset) para que se note
  // la separación entre edificios vecinos de una misma manzana.
  // Los colores salen de un PRNG propio sembrado con la seed: son solo cosméticos,
  // pero así la misma seed también se ve igual.
  const colorRng = new Rng(city.seed).fork('building-colors');
  const buildings = instancedBoxes(
    unitBox,
    grid.buildings,
    (b: Building) => buildingHeight(b),
    (b: Building) => {
      // Se tira siempre del mismo PRNG (aunque no se use) para que los colores de los demás no cambien.
      const common = colorRng.pick(BUILDING_PALETTE);
      if (b.style === 'house') return colorRng.pick(HOUSE_PALETTE);
      return b.style ? STYLE_COLOR[b.style] : common;
    },
    BUILDING_INSET,
  );
  buildings.castShadow = true;
  buildings.receiveShadow = true;
  // Los edificios marcan en el STENCIL (un búfer aparte, un número por píxel) los píxeles que
  // cubren. Las siluetas de zombies (zombieView) solo se dibujan sobre esos píxeles.
  const buildingMaterial = buildings.material as THREE.MeshStandardMaterial;
  buildingMaterial.stencilWrite = true;
  buildingMaterial.stencilRef = BUILDING_STENCIL;
  buildingMaterial.stencilFunc = THREE.AlwaysStencilFunc;
  buildingMaterial.stencilZPass = THREE.ReplaceStencilOp;
  root.add(buildings);
  const occlusion = createBuildingOcclusion(city, buildings, unitBox);
  root.add(occlusion.ghosts);

  // Recintos, canal, árboles, decoración y barricadas (blocksView).
  const blocksView = buildBlocksView(city);
  root.add(blocksView.root);

  // Plaza y helipuerto.
  const plazaBlock = grid.blocks.find((b) => b.isPlaza);
  if (plazaBlock) {
    const inner = {
      x: plazaBlock.x + SIDEWALK_WIDTH,
      y: plazaBlock.y + SIDEWALK_WIDTH,
      w: plazaBlock.w - SIDEWALK_WIDTH * 2,
      h: plazaBlock.h - SIDEWALK_WIDTH * 2,
    };
    root.add(boxMesh(unitBox, inner, 0.05, COLORS.plaza));
    root.add(helipad(inner));
  }

  // Salidas y punto de inicio: columnas de luz visibles desde lejos (en el orden de layout.exits).
  const exitBeacons = city.evac.map((point) => {
    const mesh = beacon(point.x, point.y, point.kind === 'helicopter' ? COLORS.helipad : COLORS.exit);
    root.add(mesh);
    return mesh;
  });
  root.add(beacon(city.spawn.x, city.spawn.y, COLORS.start));

  // Muro perimetral: el límite de la ciudad.
  const wallT = 1;
  const wallH = 3;
  for (const rect of [
    { x: -wallT, y: -wallT, w: grid.width + wallT * 2, h: wallT },
    { x: -wallT, y: grid.height, w: grid.width + wallT * 2, h: wallT },
    { x: -wallT, y: 0, w: wallT, h: grid.height },
    { x: grid.width, y: 0, w: wallT, h: grid.height },
  ]) {
    root.add(boxMesh(unitBox, rect, wallH, COLORS.wall));
  }

  const graphOverlay = buildGraphOverlay(city);
  graphOverlay.visible = false;
  root.add(graphOverlay);

  return {
    root,
    graphOverlay,
    exitBeacons,
    updateOcclusion: occlusion.update,
    update: blocksView.update,
    dispose() {
      // Three.js no libera memoria de la GPU solo: hay que liberar geometrías y materiales a mano.
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((m) => m.dispose());
        }
      });
    },
  };
}

/**
 * Desvanecido de edificios que tapan al jugador.
 *
 * Con cámara ortográfica, todos los rayos de visión son paralelos. Entonces, para saber si un
 * edificio tapa al jugador basta con lanzar un rayo DESDE el jugador HACIA la cámara: si choca
 * con la caja del edificio, ese edificio está entre los dos. Lanzamos varios rayos (pies, cabeza
 * y a los costados) para desvanecer también cuando el personaje está tapado a medias.
 *
 * Los InstancedMesh comparten un solo material, así que no podemos bajar la opacidad de una sola
 * copia. El truco: "esconder" esa copia en la malla normal (escala 0) y dibujarla en una segunda
 * malla de fantasmas con material transparente. Solo tocamos la GPU cuando cambia el conjunto.
 */
function createBuildingOcclusion(city: City, buildings: THREE.InstancedMesh, geometry: THREE.BufferGeometry) {
  const list = city.grid.buildings;
  const original = list.map((_, i) => {
    const m = new THREE.Matrix4();
    buildings.getMatrixAt(i, m);
    return m;
  });
  const boxes = list.map(
    (b) =>
      new THREE.Box3(
        new THREE.Vector3(b.x + BUILDING_INSET, 0, b.y + BUILDING_INSET),
        new THREE.Vector3(b.x + b.w - BUILDING_INSET, buildingHeight(b), b.y + b.h - BUILDING_INSET),
      ),
  );

  const ghosts = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ roughness: 0.85, transparent: true, opacity: 0.2, depthWrite: false }),
    Math.max(1, list.length),
  );
  ghosts.count = 0;
  // Los fantasmas siguen proyectando su sombra, así la sombra no "parpadea" al desvanecerse.
  ghosts.castShadow = true;

  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const ray = new THREE.Ray();
  const side = new THREE.Vector3();
  const color = new THREE.Color();
  let hiddenKey = '';

  function apply(hidden: number[]): void {
    const key = hidden.join(',');
    if (key === hiddenKey) return;
    hiddenKey = key;

    const hiddenSet = new Set(hidden);
    for (let i = 0; i < list.length; i++) buildings.setMatrixAt(i, hiddenSet.has(i) ? hiddenMatrix : original[i]);
    hidden.forEach((buildingIndex, k) => {
      ghosts.setMatrixAt(k, original[buildingIndex]);
      buildings.getColorAt(buildingIndex, color);
      ghosts.setColorAt(k, color);
    });
    ghosts.count = hidden.length;
    buildings.instanceMatrix.needsUpdate = true;
    ghosts.instanceMatrix.needsUpdate = true;
    if (ghosts.instanceColor) ghosts.instanceColor.needsUpdate = true;
  }

  function update(playerX?: number, playerY?: number, toCamera?: THREE.Vector3): void {
    if (playerX === undefined || playerY === undefined || !toCamera) {
      apply([]);
      return;
    }
    // "side" es la dirección horizontal de la pantalla, para los rayos de los costados.
    side.set(toCamera.z, 0, -toCamera.x).normalize();
    const hidden: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
      let blocks = false;
      for (const offset of [-0.7, 0, 0.7]) {
        for (const height of [0.2, 1.6]) {
          ray.origin.set(playerX + side.x * offset, height, playerY + side.z * offset);
          ray.direction.copy(toCamera);
          if (ray.intersectsBox(boxes[i])) {
            blocks = true;
            break;
          }
        }
        if (blocks) break;
      }
      if (blocks) hidden.push(i);
    }
    apply(hidden);
  }

  return { ghosts, update };
}

/** Crea un InstancedMesh con una caja por rectángulo. */
function instancedBoxes<T extends Rect>(
  geometry: THREE.BufferGeometry,
  rects: readonly T[],
  heightOf: (rect: T) => number,
  colorOf: (rect: T) => number,
  inset = 0,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ roughness: 0.85 }),
    Math.max(1, rects.length),
  );
  mesh.count = rects.length;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  rects.forEach((rect, i) => {
    const w = rect.w - inset * 2;
    const d = rect.h - inset * 2;
    matrix.makeScale(w, heightOf(rect), d);
    matrix.setPosition(rect.x + rect.w / 2, 0, rect.y + rect.h / 2);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, color.setHex(colorOf(rect)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function boxMesh(geometry: THREE.BufferGeometry, rect: Rect, height: number, color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry.clone(), new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  mesh.scale.set(rect.w, height, rect.h);
  mesh.position.set(rect.x + rect.w / 2, 0, rect.y + rect.h / 2);
  mesh.receiveShadow = true;
  return mesh;
}

/** Círculo amarillo con una "H" encima. */
function helipad(area: Rect): THREE.Group {
  const group = new THREE.Group();
  const cx = area.x + area.w / 2;
  const cz = area.y + area.h / 2;
  const material = new THREE.MeshStandardMaterial({ color: COLORS.helipad, roughness: 0.6 });

  const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.8, 48), material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(cx, 0.08, cz);
  group.add(ring);

  const bar = (w: number, d: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), material);
    m.position.set(cx + x, 0.1, cz + z);
    group.add(m);
  };
  bar(0.5, 3, -0.9, 0);
  bar(0.5, 3, 0.9, 0);
  bar(1.3, 0.5, 0, 0);
  return group;
}

/** Columna de luz semitransparente para marcar un punto a la distancia. */
function beacon(x: number, z: number, color: number): THREE.Mesh {
  const height = 40;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, height, 24, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.position.set(x, height / 2, z);
  return mesh;
}

/**
 * Capa de depuración: dibuja el grafo encima de la ciudad.
 * Cada cruce se colorea según su distancia BFS desde el inicio (verde = cerca, rojo = lejos)
 * y solo se dibujan los tramos abiertos. Así se "ve" el laberinto que generó el algoritmo.
 * Esa distancia es la que usaremos en el hito 6 para las zonas de dificultad.
 */
function buildGraphOverlay(city: City): THREE.Group {
  const group = new THREE.Group();
  const { graph, distanceFromStart } = city.layout;
  const maxDist = Math.max(...distanceFromStart);
  const y = 6;

  const positions: number[] = [];
  for (const edge of graph.edges) {
    if (graph.blocked[edge.id]) continue;
    positions.push(
      nodeCenter(graph.nodeX(edge.a)), y, nodeCenter(graph.nodeY(edge.a)),
      nodeCenter(graph.nodeX(edge.b)), y, nodeCenter(graph.nodeY(edge.b)),
    );
  }
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)),
    new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8 }),
  );
  lines.renderOrder = 10;
  group.add(lines);

  const sphere = new THREE.SphereGeometry(1, 12, 8);
  const nodes = new THREE.InstancedMesh(
    sphere,
    new THREE.MeshBasicMaterial({ depthTest: false, transparent: true }),
    graph.nodeCount,
  );
  nodes.renderOrder = 11;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const near = new THREE.Color(COLORS.start);
  const far = new THREE.Color(COLORS.exit);
  for (let id = 0; id < graph.nodeCount; id++) {
    matrix.makeTranslation(nodeCenter(graph.nodeX(id)), y, nodeCenter(graph.nodeY(id)));
    nodes.setMatrixAt(id, matrix);
    nodes.setColorAt(id, color.copy(near).lerp(far, distanceFromStart[id] / maxDist));
  }
  group.add(nodes);
  return group;
}
