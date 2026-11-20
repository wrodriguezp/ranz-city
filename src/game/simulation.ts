// Un paso de la simulación: une jugador, linterna, zombies y hordas.
//
// stepGame(estado, runtime, intención, dt) es todo el "juego" sin dibujo: main.ts arma la
// intención a partir del teclado y el mouse, llama a esta función 60 veces por segundo,
// y después el render lee el estado. Nada de aquí importa Three.js.

import type { City } from '../world/city';
import { createFlashlight, updateFlashlight } from './flashlight';
import { FlowField } from './flowField';
import { createPlayer, updatePlayer } from './player';
import { SpatialHash } from './spatialHash';
import type { GameState } from './state';
import { createZombie, initialHordeTimer, updateHordes, updateZombies, type ZombieRuntime } from './zombies';

/** Estructuras auxiliares que se derivan del mundo y del estado: no se serializan. */
export type Runtime = ZombieRuntime;

/** Lo que el jugador quiere hacer en este paso, ya en coordenadas del mundo. */
export interface Intent {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  toggleFlashlight: boolean;
}

export function createRuntime(city: City): Runtime {
  return {
    city,
    field: new FlowField(city.grid),
    hash: new SpatialHash(city.grid.width, city.grid.height, 2),
  };
}

export function createGameState(city: City): GameState {
  const state: GameState = {
    status: 'playing',
    time: 0,
    tick: 0,
    // El azar dinámico también parte de la seed: misma seed y mismas acciones, misma partida.
    rng: (city.seed ^ 0x9e3779b9) >>> 0,
    player: createPlayer(city.spawn.x, city.spawn.y),
    flashlight: createFlashlight(),
    zombies: [],
    nextZombieId: 0,
    corpses: [],
    hordeTimer: initialHordeTimer(),
    noiseHeat: 0,
    stats: { kills: 0, shots: 0, hordes: 0 },
    events: [],
  };
  for (const spawn of city.encounters.zombies) state.zombies.push(createZombie(state, spawn.x, spawn.y, spawn.kind));
  return state;
}

export function stepGame(state: GameState, rt: Runtime, intent: Intent, dt: number): void {
  if (state.status !== 'playing') return;
  state.time += dt;
  state.tick++;

  updatePlayer(state.player, intent, rt.city.grid, dt);

  if (intent.toggleFlashlight) state.flashlight.on = !state.flashlight.on;
  updateFlashlight(state.flashlight, dt);

  rt.field.update(state.player.x, state.player.y);
  updateZombies(state, rt, dt);
  updateHordes(state, rt, dt, 0.4);

  if (state.player.hp <= 0) {
    state.status = 'lost';
    state.events.push({ type: 'message', text: 'Te alcanzaron.', tone: 'danger' });
  }
}
