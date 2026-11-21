// Zombie City: punto de entrada.
// Dos modos:
//   - Juego: controlas al personaje con WASD y apuntas con el mouse.
//   - Revisión (V): cámara libre para ver la ciudad completa (lo que era el hito 1).
// La seed va en la URL (?seed=...) para poder compartir y repetir una ciudad.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { flashlightPower } from './game/flashlight';
import { Input } from './game/input';
import { createGameState, createRuntime, stepGame, type Intent, type Runtime } from './game/simulation';
import type { GameEvent, GameState } from './game/state';
import { buildCityView, type CityView } from './render/cityRenderer';
import { EffectsView } from './render/effectsView';
import { PropsView } from './render/propsView';
import { ExplosivesView } from './render/explosivesView';
import { HazardsView } from './render/hazardsView';
import { searchPrompt } from './game/loot';
import { exitName } from './game/escape';
import { EvacView } from './render/evacView';
import { Screens } from './ui/screens';
import { clockText } from './world/evacuation';
import { WEATHER_EFFECTS } from './world/weather';
import { WeatherView } from './render/weatherView';
import { MapView, type ExitMarker } from './ui/mapView';
import { GameCamera } from './render/gameCamera';
import { NightLighting } from './render/lighting';
import { PlayerView } from './render/playerView';
import { ZombieView } from './render/zombieView';
import { Hud } from './ui/hud';
import { DamageText } from './ui/damageText';
import { Sfx } from './audio/sfx';
import { generateCity, type City } from './world/city';
import { lightAt } from './world/streetLights';
import { addStreetLightTo, setStreetLightIntensity, StreetLightView } from './render/streetLightView';

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
let streetLightView: StreetLightView | undefined;
let weatherView: WeatherView | undefined;
let state: GameState;
let runtime: Runtime;
/** Posición y orientación del jugador en el paso anterior, para interpolar al dibujar. */
const previous = { x: 0, y: 0, facing: 0 };
const aim = { x: 0, y: 0 };
const playerView = new PlayerView();
scene.add(playerView.root);
const zombieView = new ZombieView();
scene.add(zombieView.root);
const effects = new EffectsView(lighting);
scene.add(effects.root);
const hazardsView = new HazardsView(effects);
scene.add(hazardsView.root);
const gameHud = new Hud();
const damageText = new DamageText();
/**
 * Pausa de impacto ("hitstop"): al matar o dar un golpe fuerte, la simulación se congela unos
 * pocos milisegundos. Es casi imperceptible como pausa, pero hace que el golpe se SIENTA pesado.
 */
let hitstop = 0;
const sfx = new Sfx();
let propsView: PropsView | undefined;
let explosivesView: ExplosivesView | undefined;
let mapView: MapView | undefined;
let evacView: EvacView | undefined;
const screens = new Screens();
let firstGame = true;

// Solo en desarrollo: acceso desde la consola del navegador para depurar y medir rendimiento.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __game: {
      renderer,
      scene,
      lighting,
      get state() {
        return state;
      },
      get runtime() {
        return runtime;
      },
    },
  });
}

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

  if (propsView) {
    scene.remove(propsView.root);
    propsView.dispose();
  }
  propsView = new PropsView(city.props, new Set(city.decor.burning.map((b) => b.id)));
  scene.add(propsView.root);
  if (explosivesView) {
    scene.remove(explosivesView.root);
    explosivesView.dispose();
  }
  explosivesView = new ExplosivesView(city.barrels);
  scene.add(explosivesView.root);
  if (streetLightView) {
    scene.remove(streetLightView.root);
    streetLightView.dispose();
  }
  streetLightView = new StreetLightView(city.lights);
  scene.add(streetLightView.root);
  if (weatherView) {
    scene.remove(weatherView.root);
    weatherView.dispose();
  }
  weatherView = new WeatherView(scene, city.weather);
  weatherView.setActive(mode === 'play');
  scene.add(weatherView.root);

  startGame();
  resetReviewCamera();

  const url = new URL(window.location.href);
  url.searchParams.set('seed', seedText);
  window.history.replaceState(null, '', url);
}

/** Empieza (o reinicia) la partida en la ciudad actual. */
function startGame(): void {
  state = createGameState(city);
  runtime = createRuntime(city);
  previous.x = state.player.x;
  previous.y = state.player.y;
  previous.facing = state.player.facing;
  aim.x = state.player.x + 1;
  aim.y = state.player.y;
  input.clearPressed();
  effects.reset();
  damageText.clear();
  hitstop = 0;
  gameHud.clearMessages();
  // Los vehículos de evacuación vuelven a su lugar en cada partida.
  if (evacView) {
    scene.remove(evacView.root);
    evacView.dispose();
  }
  if (cityView) {
    evacView = new EvacView(city.evac, city.grid.width, cityView.exitBeacons);
    scene.add(evacView.root);
  }
  if (mapView) mapView.reset(city);
  else mapView = new MapView(city);
  mapView.setVisible(mode === 'play');
  // La primera partida empieza con la pantalla de controles; las siguientes, directo.
  screens.show(firstGame ? 'intro' : null, firstGame ? summary() : undefined);
  firstGame = false;
  gameCamera.snapTo(state.player.x, state.player.y);
  // Todo lo que tiene material estándar recibe la luz de los faroles (los parchados se saltan).
  addStreetLightTo(scene);
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
  gameHud.setVisible(mode === 'play');
  damageText.setVisible(mode === 'play');
  mapView?.setVisible(mode === 'play');
  reviewControls.enabled = mode === 'review';
  lighting.setDaylight(mode === 'review');
  setStreetLightIntensity(mode === 'review' ? 0 : 1.5);
  weatherView?.setActive(mode === 'play');
}

// --- Lógica (paso fijo) ---------------------------------------------------------------------

/** Traduce teclado y mouse a una intención en coordenadas del mundo. */
function readIntent(): Intent {
  const move = input.screenMove();
  const axes = gameCamera.screenAxesOnGround();
  const mouseOnGround = gameCamera.groundPointUnderMouse(input.mouse.x, input.mouse.y);
  if (mouseOnGround) {
    aim.x = mouseOnGround.x;
    aim.y = mouseOnGround.y;
  }
  return {
    // La dirección de pantalla (derecha/arriba) se proyecta sobre los ejes del suelo.
    moveX: move.x * axes.rightX + move.y * axes.upX,
    moveY: move.x * axes.rightY + move.y * axes.upY,
    aimX: aim.x,
    aimY: aim.y,
    toggleFlashlight: input.consume('KeyF'),
    changeBattery: input.consume('KeyB'),
    useMedkit: input.consume('KeyH'),
    search: input.isDown('KeyE'),
    sneak: input.isDown('ShiftLeft') || input.isDown('ShiftRight'),
    attack: input.consume('Mouse0'),
    attackHeld: input.isDown('Mouse0'),
    throwGrenade: input.consume('KeyG'),
    cycleThrowable: input.consume('KeyT'),
    melee: input.consume('Mouse2'),
    dash: input.consume('Space'),
    reload: input.consume('KeyR'),
    select: input.consume('KeyQ')
      ? 'next'
      : input.consume('Digit1')
        ? 'melee'
        : input.consume('Digit2')
          ? 'pistol'
          : input.consume('Digit3')
            ? 'shotgun'
            : input.consume('Digit4')
              ? 'smg'
              : input.consume('Digit5')
                ? 'special'
                : undefined,
  };
}

function step(dt: number): void {
  previous.x = state.player.x;
  previous.y = state.player.y;
  previous.facing = state.player.facing;
  stepGame(state, runtime, readIntent(), dt);
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
let stepMs = 0;

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
    // Con una pantalla abierta (inicio, pausa, fin) la simulación queda congelada.
    hitstop = Math.max(0, hitstop - frameDt);
    accumulator = screens.current ? 0 : hitstop > 0 ? accumulator : accumulator + frameDt;
    const t0 = performance.now();
    while (accumulator >= STEP) {
      step(STEP);
      accumulator -= STEP;
    }
    if (state.status !== 'playing' && !screens.current) screens.show(state.status, summary());
    stepMs = stepMs * 0.95 + (performance.now() - t0) * 0.05;
    const alpha = accumulator / STEP;
    const p = state.player;
    const x = previous.x + (p.x - previous.x) * alpha;
    const y = previous.y + (p.y - previous.y) * alpha;
    const facing = lerpAngle(previous.facing, p.facing, alpha);
    playerView.update(x, y, facing, p.air);
    playerView.setWeapon(state.weapon.current, state.weapon.melee);
    zombieView.update(state, city.grid, x, y, alpha);
    explosivesView?.update(state, now / 1000);
    hazardsView.update(state, now / 1000, frameDt);
    streetLightView?.update(state.time);
    gameCamera.follow(x, y, aim.x, aim.y, frameDt);
    lighting.update(x, y, facing, flashlightPower(state.flashlight, state.time), frameDt);
    cityView?.updateOcclusion(x, y, gameCamera.toCameraDirection(toCamera));
    cityView?.update(now / 1000, x, y);
    weatherView?.update(x, y, now / 1000);
    // Los eventos de los pasos de este cuadro: efectos y mensajes, y después se descartan.
    const axes = gameCamera.screenAxesOnGround();
    const listener = { x, y, rightX: axes.rightX, rightY: axes.rightY };
    sfx.handle(state.events, listener);
    if (!screens.current) sfx.ambient(frameDt, listener, state.zombies, state.player.hp);
    effects.handle(state.events, city.seed % 1000);
    damageText.handle(state.events, now / 1000);
    feel(state.events);
    gameHud.handle(state.events, now / 1000);
    state.events.length = 0;
    effects.update(frameDt);
    gameHud.update(state, now / 1000, lightAt(city.lights, state.player.x, state.player.y, state.time));
    damageText.update(gameCamera.camera, now / 1000);
    propsView?.update(state, now / 1000);
    const prompt = searchPrompt(state, city.props);
    gameHud.setPrompt(prompt.text, prompt.progress);
    mapView?.update(state, frameDt, exitMarkers());
    evacView?.update(state, frameDt, now / 1000);
    gameHud.setEvac(clockText(state.time), evacLines());
    renderer.render(scene, gameCamera.camera);
  } else {
    playerView.update(state.player.x, state.player.y, state.player.facing);
    zombieView.update(state, city.grid, state.player.x, state.player.y, 1);
    explosivesView?.update(state, now / 1000);
    cityView?.updateOcclusion();
    cityView?.update(now / 1000);
    reviewControls.update();
    renderer.render(scene, reviewCamera);
  }

  updateHud();
}

/** Sacudida de cámara y pausa de impacto según lo que pasó en estos pasos. */
function feel(events: readonly GameEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case 'shot':
        if (event.first) gameCamera.shake(event.weapon === 'shotgun' ? 0.32 : event.weapon === 'smg' ? 0.07 : 0.12);
        break;
      case 'explosion': {
        // Más fuerte mientras más cerca: una granada al lado sacude todo; una lejana, apenas.
        const d = Math.hypot(event.x - state.player.x, event.y - state.player.y);
        const near = Math.max(0, 1 - d / 30);
        gameCamera.shake((event.kind === 'rock' ? 0.4 : event.kind === 'bloater' ? 0.45 : 0.9) * near);
        hitstop = Math.max(hitstop, event.kind === 'rock' ? 0.03 : 0.07 * near);
        break;
      }
      case 'hit':
        if (event.killed) {
          gameCamera.shake(event.gib ? 0.35 : 0.2);
          hitstop = Math.max(hitstop, event.gib ? 0.08 : 0.045);
        } else if (event.crit) {
          hitstop = Math.max(hitstop, 0.05);
        }
        break;
      case 'hurt':
        gameCamera.shake(Math.min(0.6, 0.15 + event.damage / 60));
        break;
      default:
        break;
    }
  }
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
  const seed = `seed: <b>${escapeHtml(city.seedText)}</b>  (huella ${city.fingerprint}) · ${city.weather}`;
  let text: string;
  if (mode === 'play') {
    const light = state.flashlight;
    text =
      `<b>ZOMBIE CITY</b> · ${fps} FPS · lógica ${stepMs.toFixed(2)} ms\n${seed}\n` +
      `zombies ${state.zombies.length} · horda en ${Math.ceil(state.hordeTimer)} s · ruido ${state.noiseHeat.toFixed(1)}` +
      ` · linterna ${light.on ? 'on' : 'off'}\n` +
      `[Esc] pausa y controles  [V] vista de revisión  [F3] grafo`;
  } else {
    const exits = city.layout.exits
      .map((e) => `  ${e.kind === 'helicopter' ? 'helicóptero (plaza)' : 'carretera'}: ${e.distance} tramos`)
      .join('\n');
    text =
      `<b>ZOMBIE CITY</b> · vista de revisión\n${seed}\n` +
      `${city.grid.buildings.length} edificios · ${city.layout.cutCount} calles cortadas\n` +
      `salidas (desde el inicio verde):\n${exits}\n\n` +
      `[V] volver a jugar  [N] nueva seed  [F3] grafo  [R] recentrar\n` +
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
    case 'KeyM':
      if (mode === 'play' && mapView) mapView.setOpen(!mapView.open);
      break;
    case 'KeyO':
      gameHud.flash(sfx.toggleMute() ? 'Sonido apagado [O]' : 'Sonido encendido [O]');
      break;
    case 'F3':
      event.preventDefault(); // en el navegador F3 abre "buscar"
      if (cityView) cityView.graphOverlay.visible = !cityView.graphOverlay.visible;
      break;
    case 'KeyR':
      if (mode === 'review') resetReviewCamera();
      break;
    case 'Enter':
      if (state.status !== 'playing') startGame();
      else if (screens.current === 'intro' || screens.current === 'pause') resume();
      break;
    case 'Escape':
      if (mode !== 'play' || state.status !== 'playing') break;
      if (screens.current === 'pause') resume();
      else if (!screens.current) {
        mapView?.setOpen(false);
        screens.show('pause', summary());
      }
      break;
  }
});

/** Rótulos de las salidas para el mapa. */
function exitMarkers(): ExitMarker[] {
  return city.evac.map((point) => ({
    label: point.kind === 'helicopter' ? 'Helicóptero' : 'Carretera',
    detail: state.escape.departed[point.index] ? 'se fue' : point.deadline === null ? 'espera' : clockText(point.deadline),
    closed: state.escape.departed[point.index],
  }));
}

/** Cierra la pantalla de inicio o de pausa y sigue jugando. */
function resume(): void {
  screens.show(null);
  input.clearPressed();
}

document.getElementById('screen')!.addEventListener('pointerdown', (event) => {
  event.stopPropagation();
  if (screens.current === 'intro' || screens.current === 'pause') resume();
});

/** Datos para las pantallas de fin (y la seed en las de inicio/pausa). */
function summary() {
  const t = Math.floor(state.time);
  const via = state.escape.escapedVia;
  return {
    seed: city.seedText,
    weather: WEATHER_EFFECTS[city.weather].label,
    time: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
    clock: clockText(state.time),
    kills: state.stats.kills,
    shots: state.stats.shots,
    via: via >= 0 ? exitName(city.evac[via]) : undefined,
  };
}

/** Líneas del panel de evacuación: cada salida, su hora y cuánto falta. */
function evacLines(): { text: string; tone: 'open' | 'soon' | 'closed' | 'always' }[] {
  return city.evac.map((point) => {
    const name = point.kind === 'helicopter' ? 'Helicóptero' : 'Carretera';
    if (state.escape.departed[point.index]) return { text: `${name} · se fue`, tone: 'closed' };
    if (point.deadline === null) return { text: `${name} · espera`, tone: 'always' };
    const left = Math.max(0, point.deadline - state.time);
    const m = Math.floor(left / 60);
    const s = Math.floor(left % 60);
    return {
      text: `${name} · ${clockText(point.deadline)} <span class="dim">(${m}:${String(s).padStart(2, '0')})</span>`,
      tone: left < 60 ? 'soon' : 'open',
    };
  });
}

// Rueda del mouse: acercar o alejar la cámara de juego (en la vista de revisión la usa OrbitControls).
renderer.domElement.addEventListener(
  'wheel',
  (event) => {
    if (mode !== 'play') return;
    event.preventDefault();
    gameCamera.zoom(Math.sign(event.deltaY));
  },
  { passive: false },
);

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

// Solo en desarrollo: acceso al estado desde la consola del navegador para depurar.
if (import.meta.env.DEV) {
  (window as unknown as { __zc: unknown }).__zc = {
    get state() {
      return state;
    },
    get city() {
      return city;
    },
  };
}
