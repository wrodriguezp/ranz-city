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

/**
 * Estamina: la comparten el dash y los golpes cuerpo a cuerpo. Se recupera sola, pero solo un
 * momento después del último esfuerzo (STAMINA_DELAY): así no se puede encadenar todo sin parar.
 */
export const STAMINA_MAX = 100;
const STAMINA_REGEN = 30;
const STAMINA_DELAY = 0.6;
/**
 * Dash: un impulso corto (~3 tiles) en la dirección en que caminas (o hacia donde miras si estás
 * quieto). Durante una fracción de segundo eres invulnerable y los zombies no te empujan: sirve
 * para salir de un encierro o esquivar la roca del tanque.
 */
export const DASH_COST = 30;
const DASH_SPEED = 17;
const DASH_TIME = 0.17;
const DASH_COOLDOWN = 0.45;
const DASH_INVULN = 0.3;

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
  /** Altura y velocidad vertical: una explosión o el tanque te pueden mandar a volar. */
  air: number;
  airV: number;
  /** Posición del paso anterior (el tanque la usa para adelantar la puntería de la roca). */
  prevX: number;
  prevY: number;
  stamina: number;
  /** Segundos hasta que la estamina empieza a recuperarse. */
  staminaDelay: number;
  /** Segundos de dash que quedan (0 = no está en un dash) y su dirección. */
  dashTime: number;
  dashX: number;
  dashY: number;
  dashCooldown: number;
  /** Segundos de invulnerabilidad que quedan. */
  invuln: number;
}

export interface PlayerIntent {
  /** Dirección de movimiento ya en ejes del MUNDO, normalizada (o 0,0 si está quieto). */
  moveX: number;
  moveY: number;
  /** Punto del suelo al que apunta el mouse, en tiles. */
  aimX: number;
  aimY: number;
  sneak: boolean;
  dash: boolean;
}

export function createPlayer(x: number, y: number): PlayerState {
  return {
    x,
    y,
    facing: 0,
    hp: PLAYER_MAX_HP,
    knockX: 0,
    knockY: 0,
    hurtTimer: 99,
    sneaking: false,
    stride: 0,
    air: 0,
    airV: 0,
    prevX: x,
    prevY: y,
    stamina: STAMINA_MAX,
    staminaDelay: 0,
    dashTime: 0,
    dashX: 0,
    dashY: 0,
    dashCooldown: 0,
    invuln: 0,
  };
}

/** Gasta estamina (devuelve false si no alcanza) y frena la recuperación un momento. */
export function spendStamina(player: PlayerState, amount: number): boolean {
  player.staminaDelay = STAMINA_DELAY;
  if (player.stamina < amount) return false;
  player.stamina -= amount;
  return true;
}

/** Devuelve qué pasó con el dash en este paso: 'dash' si arrancó, 'tired' si no hubo estamina. */
export function updatePlayer(player: PlayerState, intent: PlayerIntent, grid: TileGrid, dt: number): 'dash' | 'tired' | null {
  let result: 'dash' | 'tired' | null = null;
  player.sneaking = intent.sneak;
  player.dashCooldown = Math.max(0, player.dashCooldown - dt);
  player.invuln = Math.max(0, player.invuln - dt);
  player.staminaDelay = Math.max(0, player.staminaDelay - dt);
  if (player.staminaDelay <= 0) player.stamina = Math.min(STAMINA_MAX, player.stamina + STAMINA_REGEN * dt);

  if (intent.dash && player.dashCooldown <= 0 && player.dashTime <= 0 && player.air <= 0) {
    if (spendStamina(player, DASH_COST)) {
      const moving = intent.moveX !== 0 || intent.moveY !== 0;
      player.dashX = moving ? intent.moveX : Math.cos(player.facing);
      player.dashY = moving ? intent.moveY : Math.sin(player.facing);
      player.dashTime = DASH_TIME;
      player.dashCooldown = DASH_COOLDOWN;
      player.invuln = DASH_INVULN;
      result = 'dash';
    } else {
      result = 'tired';
    }
  }
  player.prevX = player.x;
  player.prevY = player.y;
  // En el aire: sigue el arco y casi no se controla el movimiento.
  if (player.airV !== 0 || player.air > 0) {
    player.airV -= 30 * dt;
    player.air += player.airV * dt;
    if (player.air <= 0) {
      player.air = 0;
      player.airV = 0;
    }
  }
  const airborne = player.air > 0;
  const speed = PLAYER_SPEED * (intent.sneak ? SNEAK_SPEED_FACTOR : 1) * (airborne ? 0.25 : 1);
  let vx = intent.moveX * speed + player.knockX;
  let vy = intent.moveY * speed + player.knockY;
  if (player.dashTime > 0) {
    player.dashTime -= dt;
    vx = player.dashX * DASH_SPEED + player.knockX * 0.3;
    vy = player.dashY * DASH_SPEED + player.knockY * 0.3;
  }
  const moved = moveCircle(grid, player.x, player.y, PLAYER_RADIUS, vx * dt, vy * dt);
  player.stride += Math.hypot(moved.x - player.x, moved.y - player.y);
  // El empujón decae exponencialmente: ~90% menos en un cuarto de segundo.
  const decay = Math.exp((airborne ? -2 : -9) * dt);
  player.knockX *= decay;
  player.knockY *= decay;
  player.hurtTimer += dt;
  player.x = moved.x;
  player.y = moved.y;

  // Mirar hacia el mouse. Si el mouse está justo encima del jugador, mantenemos el ángulo anterior.
  const ax = intent.aimX - player.x;
  const ay = intent.aimY - player.y;
  if (ax * ax + ay * ay > 0.01) player.facing = Math.atan2(ay, ax);
  return result;
}
