// Hito 1: visor de la ciudad generada.
// Muestra la ciudad completa con una cámara libre para revisar la generación.
// Teclas: N = nueva seed, G = mostrar/ocultar el grafo, R = recentrar la cámara.
// La seed va en la URL (?seed=...) para poder compartir y repetir una ciudad.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildCityView, type CityView } from './render/cityRenderer';
import { generateCity, type City } from './world/city';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);

// Luz de día para revisar la ciudad. La noche y la linterna llegan en el hito 3.
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

// Cámara ortográfica: sin perspectiva, los objetos no se achican con la distancia.
// Es la base de la vista isométrica que tendrá el juego. "viewSize" es cuántas unidades
// del mundo caben en el alto de la pantalla.
const viewSize = 160;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minZoom = 0.5;
controls.maxZoom = 12;
controls.maxPolarAngle = Math.PI / 2.2;

function updateCameraFrustum(): void {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = (-viewSize * aspect) / 2;
  camera.right = (viewSize * aspect) / 2;
  camera.top = viewSize / 2;
  camera.bottom = -viewSize / 2;
  camera.updateProjectionMatrix();
}

const hud = document.getElementById('hud')!;
let city: City;
let view: CityView | undefined;

function loadCity(seedText: string): void {
  if (view) {
    scene.remove(view.root);
    view.dispose();
  }
  const graphVisible = view?.graphOverlay.visible ?? false;

  const t0 = performance.now();
  city = generateCity(seedText);
  const genMs = performance.now() - t0;
  view = buildCityView(city);
  view.graphOverlay.visible = graphVisible;
  scene.add(view.root);

  // El sol y su sombra cubren toda la ciudad.
  const { width, height } = city.grid;
  const center = new THREE.Vector3(width / 2, 0, height / 2);
  sun.position.set(center.x - 60, 120, center.z - 40);
  sun.target.position.copy(center);
  const half = Math.max(width, height) * 0.75;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 400 });
  sun.shadow.camera.updateProjectionMatrix();

  resetCamera();

  const url = new URL(window.location.href);
  url.searchParams.set('seed', seedText);
  window.history.replaceState(null, '', url);

  const exits = city.layout.exits
    .map((e) => `  ${e.kind === 'helicopter' ? 'helicóptero (plaza)' : 'carretera'}: ${e.distance} tramos`)
    .join('\n');
  hud.innerHTML =
    `<b>ZOMBIE CITY</b> · hito 1: ciudad\n` +
    `seed: <b>${escapeHtml(seedText)}</b>  (huella ${city.fingerprint})\n` +
    `${city.layout.graph.nodesX - 1}×${city.layout.graph.nodesY - 1} manzanas · ${city.grid.width}×${city.grid.height} tiles\n` +
    `${city.grid.buildings.length} edificios · ${city.layout.cutCount} calles cortadas · generada en ${genMs.toFixed(1)} ms\n` +
    `salidas (desde el inicio verde):\n${exits}\n\n` +
    `[N] nueva seed  [G] grafo  [R] recentrar\n` +
    `arrastrar: girar · rueda: zoom · clic derecho: mover`;
}

/** Vuelve a la vista isométrica clásica: 45° de giro y unos 35° de inclinación. */
function resetCamera(): void {
  const { width, height } = city.grid;
  const target = new THREE.Vector3(width / 2, 0, height / 2);
  const distance = 200;
  camera.position.set(target.x + distance, target.y + distance * 0.82, target.z + distance);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  controls.target.copy(target);
  controls.update();
}

/** Seed nueva al azar. Usar Math.random() aquí está bien: elige QUÉ seed jugar, no genera el mundo. */
function randomSeed(): string {
  return String(Math.floor(Math.random() * 1_000_000));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  switch (event.key.toLowerCase()) {
    case 'n':
      loadCity(randomSeed());
      break;
    case 'g':
      if (view) view.graphOverlay.visible = !view.graphOverlay.visible;
      break;
    case 'r':
      resetCamera();
      break;
  }
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateCameraFrustum();
});

updateCameraFrustum();
loadCity(new URLSearchParams(window.location.search).get('seed') || randomSeed());

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
