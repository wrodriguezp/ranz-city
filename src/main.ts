// Zombie City: punto de entrada.
// Dos modos:
//   - Juego: controlas al personaje con WASD y apuntas con el mouse.
//   - Revisión (V): cámara libre para ver la ciudad completa (lo que era el hito 1).
// La seed va en la URL (?seed=...) para poder compartir y repetir una ciudad.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Input } from './game/input';
import { createFlashlight, flashlightPower, updateFlashlight } from './game/flashlight';
import { createPlayer, updatePlayer, type PlayerState } from './game/player';
import { buildCityView, type CityView } from './render/cityRenderer';
import { GameCamera } from './render/gameCamera';
import { NightLighting } from './render/lighting';
import { PlayerView } from './render/playerView';
import { generateCity, type City } from './world/city';

// --- Render ---------------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
const lighting = new NightLighting(scene);

const gameCamera = new GameCamera();

// Solo en desarrollo: acceso desde la consola del navegador para depurar y medir rendimiento.
if (import.meta.env.DEV) Object.assign(window, { __game: { renderer, scene, lighting } });

// Cámara de revisión (modo V): ortográfica con controles de órbita.
const REVIEW_VIEW_SIZE = 160;
const reviewCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
const reviewControls = new OrbitControls(reviewCamera, renderer.domElement);
reviewControls.enableDamping = true;
reviewControls.minZoom = 0.5;
reviewControls.maxZoom = 12;
reviewControls.maxPolarAngle = Math.PI / 2.2;
reviewControls.enabled = false;

function resizeCameras(): void {
  const aspect = window.innerWidth / window.innerHeight;
  gameCamera.resize(aspect);
  reviewCamera.left = (-REVIEW_VIEW_SIZE * aspect) / 2;
  reviewCamera.right = (REVIEW_VIEW_SIZE * aspect) / 2;
  reviewCamera.top = REVIEW_VIEW_SIZE / 2;
  reviewCamera.bottom = -REVIEW_VIEW_SIZE / 2;
  reviewCamera.updateProjectionMatrix();
}

// --- Estado ---------------------------------------------------------------------------------

type Mode = 'play' | 'review';
let mode: Mode = 'play';

const input = new Input(renderer.domElement);
const hud = document.getElementById('hud')!;

let city: City;
let cityView: CityView | undefined;
let player: PlayerState;
/** Estado del jugador en el paso lógico anterior, para interpolar al dibujar (ver el bucle). */
let previous: PlayerState;
const aim = { x: 0, y: 0 };
let flashlight = createFlashlight();
/** Segundos de partida (solo avanza en el paso lógico). */
let gameTime = 0;
const playerView = new PlayerView();
scene.add(playerView.root);

function loadCity(seedText: string): void {
  const graphVisible = cityView?.graphOverlay.visible ?? false;
  if (cityView) {
    scene.remove(cityView.root);
    cityView.dispose();
  }

  city = generateCity(seedText);
  cityView = buildCityView(city);
  cityView.graphOverlay.visible = graphVisible;
  scene.add(cityView.root);

  player = createPlayer(city.spawn.x, city.spawn.y);
  previous = { ...player };
  flashlight = createFlashlight();
  gameTime = 0;
  aim.x = player.x + 1;
  aim.y = player.y;
  gameCamera.snapTo(player.x, player.y);

  resetReviewCamera();

  const url = new URL(window.location.href);
  url.searchParams.set('seed', seedText);
  window.history.replaceState(null, '', url);
}

function resetReviewCamera(): void {
  const { width, height } = city.grid;
  const target = new THREE.Vector3(width / 2, 0, height / 2);
  const distance = 200;
  reviewCamera.position.set(target.x + distance, distance * 0.82, target.z + distance);
  reviewCamera.zoom = 1;
  reviewCamera.updateProjectionMatrix();
  reviewControls.target.copy(target);
  reviewControls.update();
}

/** Seed nueva al azar. Usar Math.random() aquí está bien: elige QUÉ seed jugar, no genera el mundo. */
function randomSeed(): string {
  return String(Math.floor(Math.random() * 1_000_000));
}

function setMode(next: Mode): void {
  mode = next;
  reviewControls.enabled = mode === 'review';
  lighting.setDaylight(mode === 'review');
}

// --- Lógica (paso fijo) ---------------------------------------------------------------------

/**
 * Un paso de lógica. Siempre recibe el mismo dt (1/60 s).
 * Convierte la entrada de pantalla en una intención en coordenadas del mundo y actualiza al jugador.
 */
function step(dt: number): void {
  previous = { ...player };
  gameTime += dt;
  updateFlashlight(flashlight, dt);

  const move = input.screenMove();
  const axes = gameCamera.screenAxesOnGround();
  const mouseOnGround = gameCamera.groundPointUnderMouse(input.mouse.x, input.mouse.y);
  if (mouseOnGround) {
    aim.x = mouseOnGround.x;
    aim.y = mouseOnGround.y;
  }

  updatePlayer(
    player,
    {
      // La dirección de pantalla (derecha/arriba) se proyecta sobre los ejes del suelo.
      moveX: move.x * axes.rightX + move.y * axes.upX,
      moveY: move.x * axes.rightY + move.y * axes.upY,
      aimX: aim.x,
      aimY: aim.y,
    },
    city.grid,
    dt,
  );
}

// --- Bucle principal ------------------------------------------------------------------------

/**
 * Paso fijo con acumulador.
 * La pantalla puede ir a 60, 144 o 30 FPS, pero la lógica siempre avanza en pasos de 1/60 s:
 * acumulamos el tiempo real transcurrido y ejecutamos tantos pasos como quepan.
 * Así el juego se comporta igual en cualquier PC (y dos máquinas en red pueden simular lo mismo).
 *
 * El tiempo que sobra (menos de un paso) se usa para INTERPOLAR: dibujamos al jugador entre
 * su posición del paso anterior y la actual. Sin esto, en una pantalla de 144 Hz el personaje
 * se vería a tirones, porque su posición solo cambia 60 veces por segundo.
 */
const STEP = 1 / 60;
const toCamera = new THREE.Vector3();
let accumulator = 0;
let lastTime = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let fps = 0;

function frame(now: number): void {
  // Si la pestaña estuvo en segundo plano, no queremos simular 10 segundos de golpe.
  const frameDt = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  fpsFrames++;
  fpsTime += frameDt;
  if (fpsTime >= 0.5) {
    fps = Math.round(fpsFrames / fpsTime);
    fpsFrames = 0;
    fpsTime = 0;
  }

  if (mode === 'play') {
    accumulator += frameDt;
    while (accumulator >= STEP) {
      step(STEP);
      accumulator -= STEP;
    }
    const alpha = accumulator / STEP;
    const x = previous.x + (player.x - previous.x) * alpha;
    const y = previous.y + (player.y - previous.y) * alpha;
    playerView.update(x, y, lerpAngle(previous.facing, player.facing, alpha));
    gameCamera.follow(x, y, aim.x, aim.y, frameDt);
    lighting.update(x, y, lerpAngle(previous.facing, player.facing, alpha), flashlightPower(flashlight, gameTime), frameDt);
    cityView?.updateOcclusion(x, y, gameCamera.toCameraDirection(toCamera));
    renderer.render(scene, gameCamera.camera);
  } else {
    playerView.update(player.x, player.y, player.facing);
    cityView?.updateOcclusion();
    reviewControls.update();
    renderer.render(scene, reviewCamera);
  }

  updateHud();
}

/** Interpola ángulos por el camino corto (de 350° a 10° pasa por 0°, no por 180°). */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// --- HUD y teclas ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let lastHud = '';
function updateHud(): void {
  const seed = `seed: <b>${escapeHtml(city.seedText)}</b>  (huella ${city.fingerprint})`;
  let text: string;
  if (mode === 'play') {
    text =
      `<b>ZOMBIE CITY</b> · hito 3: oscuridad · ${fps} FPS\n${seed}\n` +
      `linterna: ${flashlight.on ? 'encendida' : 'apagada'} · batería ${Math.ceil(flashlight.charge)}%\n\n` +
      `[WASD] moverse  [mouse] apuntar  [F] linterna\n[V] vista de revisión  [N] nueva seed  [G] grafo`;
  } else {
    const exits = city.layout.exits
      .map((e) => `  ${e.kind === 'helicopter' ? 'helicóptero (plaza)' : 'carretera'}: ${e.distance} tramos`)
      .join('\n');
    text =
      `<b>ZOMBIE CITY</b> · vista de revisión\n${seed}\n` +
      `${city.grid.buildings.length} edificios · ${city.layout.cutCount} calles cortadas\n` +
      `salidas (desde el inicio verde):\n${exits}\n\n` +
      `[V] volver a jugar  [N] nueva seed  [G] grafo  [R] recentrar\n` +
      `arrastrar: girar · rueda: zoom · clic derecho: mover`;
  }
  // Solo tocamos el DOM si el texto cambió.
  if (text !== lastHud) {
    hud.innerHTML = text;
    lastHud = text;
  }
}

window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  switch (event.code) {
    case 'KeyV':
      setMode(mode === 'play' ? 'review' : 'play');
      break;
    case 'KeyN':
      loadCity(randomSeed());
      break;
    case 'KeyG':
      if (cityView) cityView.graphOverlay.visible = !cityView.graphOverlay.visible;
      break;
    case 'KeyR':
      if (mode === 'review') resetReviewCamera();
      break;
    case 'KeyF':
      flashlight.on = !flashlight.on;
      break;
  }
});

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeCameras();
});

resizeCameras();
setMode('play');
loadCity(new URLSearchParams(window.location.search).get('seed') || randomSeed());
// El bucle arranca recién cuando la ciudad cargó bien: si loadCity falla, vemos un solo error
// en vez de uno por cuadro (60 por segundo) sobre un estado incompleto.
lastTime = performance.now();
renderer.setAnimationLoop(frame);
