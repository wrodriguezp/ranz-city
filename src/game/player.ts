// Lógica del jugador: posición, hacia dónde mira y movimiento con colisión.
// Todo en coordenadas del mundo 2D (tiles). No sabe nada de Three.js ni de la cámara.

import type { TileGrid } from '../world/tileGrid';
import { moveCircle } from './collision';

/** Tiles por segundo. Una calle (4 tiles) se cruza en menos de un segundo. */
export const PLAYER_SPEED = 5.5;
export const PLAYER_RADIUS = 0.4;
export const PLAYER_MAX_HP = 100;
/** Agachado se camina a menos de la mitad de velocidad, a cambio de no hacer ruido al pisar. */
export const SNEAK_SPEED_FACTOR = 0.45;

export interface PlayerState {
  x: number;
  y: number;
  /** Ángulo hacia donde mira, en radianes, en el plano del mundo (0 = +x). */
  facing: number;
  hp: number;
  /** Empujón recibido (p. ej. la embestida del tanque), en tiles/s; se disipa solo. */
  knockX: number;
  knockY: number;
  /** Segundos desde el último daño (para el efecto rojo de la pantalla). */
  hurtTimer: number;
  /** Modo sigilo (Shift mantenido). */
  sneaking: boolean;
  /** Distancia caminada desde el último paso (para el sonido y el ruido de las pisadas). */
  stride: number;
}

export interface PlayerIntent {
  /** Dirección de movimiento ya en ejes del MUNDO, normalizada (o 0,0 si está quieto). */
  moveX: number;
  moveY: number;
  /** Punto del suelo al que apunta el mouse, en tiles. */
  aimX: number;
  aimY: number;
  sneak: boolean;
}

export function createPlayer(x: number, y: number): PlayerState {
  return { x, y, facing: 0, hp: PLAYER_MAX_HP, knockX: 0, knockY: 0, hurtTimer: 99, sneaking: false, stride: 0 };
}

export function updatePlayer(player: PlayerState, intent: PlayerIntent, grid: TileGrid, dt: number): void {
  player.sneaking = intent.sneak;
  const speed = PLAYER_SPEED * (intent.sneak ? SNEAK_SPEED_FACTOR : 1);
  const moved = moveCircle(
    grid,
    player.x,
    player.y,
    PLAYER_RADIUS,
    (intent.moveX * speed + player.knockX) * dt,
    (intent.moveY * speed + player.knockY) * dt,
  );
  player.stride += Math.hypot(moved.x - player.x, moved.y - player.y);
  // El empujón decae exponencialmente: ~90% menos en un cuarto de segundo.
  const decay = Math.exp(-9 * dt);
  player.knockX *= decay;
  player.knockY *= decay;
  player.hurtTimer += dt;
  player.x = moved.x;
  player.y = moved.y;

  // Mirar hacia el mouse. Si el mouse está justo encima del jugador, mantenemos el ángulo anterior.
  const ax = intent.aimX - player.x;
  const ay = intent.aimY - player.y;
  if (ax * ax + ay * ay > 0.01) player.facing = Math.atan2(ay, ax);
}
