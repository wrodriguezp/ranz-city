// Estado DINÁMICO de la partida: todo lo que cambia mientras se juega.
//
// Regla del proyecto: la seed genera solo el mundo estático (City). Esto es lo otro, y se guarda
// como datos planos (números, strings, arreglos), sin clases ni referencias a Three.js.
// Así se puede serializar con JSON: guardar la partida, o en el futuro multijugador, que el host
// mande este estado a los demás jugadores.

import type { WeaponState } from './combat';
import type { EscapeState } from './escape';
import type { FlashlightState } from './flashlight';
import type { LootState } from './loot';
import type { PlayerState } from './player';

export type ZombieKind = 'walker' | 'tank';

/**
 * Máquina de estados de un zombie:
 *  idle        quieto, balanceándose
 *  wander      deambula sin rumbo
 *  investigate va hacia un ruido que escuchó
 *  chase       persigue al jugador (lo vio, o es parte de una horda que "sabe" dónde está)
 *  return      (tanque) vuelve a su puesto tras perder al jugador
 *  charge      (tanque) embestida en línea recta
 *  stunned     aturdido después de embestir
 */
export type ZombieMode = 'idle' | 'wander' | 'investigate' | 'chase' | 'return' | 'charge' | 'stunned';

export interface Zombie {
  id: number;
  kind: ZombieKind;
  x: number;
  y: number;
  /** Posición en el paso anterior, solo para interpolar al dibujar. */
  prevX: number;
  prevY: number;
  facing: number;
  hp: number;
  maxHp: number;
  radius: number;
  /** Velocidad al perseguir (cada zombie tiene la suya, así la horda se "estira"). */
  speed: number;
  mode: ZombieMode;
  /** Temporizador del modo actual (segundos). */
  timer: number;
  targetX: number;
  targetY: number;
  /** ¿Vio al jugador en su último "pensamiento"? */
  seesPlayer: boolean;
  lastSeenAt: number;
  attackCooldown: number;
  /** Empujón recibido (tiles/s); se disipa solo. */
  knockX: number;
  knockY: number;
  /** Tiempo restante de aturdimiento por golpe (no avanza ni ataca). */
  stagger: number;
  /** Destello blanco al recibir un golpe (solo visual). */
  hitFlash: number;
  /** Las hordas persiguen sin necesidad de ver al jugador, hasta que se les acaba el tiempo. */
  hordeUntil: number;
  homeX: number;
  homeY: number;
}

export interface Corpse {
  x: number;
  y: number;
  facing: number;
  kind: ZombieKind;
}

/** Sucesos de un paso, para que el render y el HUD reaccionen (efectos, mensajes). No se guardan. */
export type GameEvent =
  | { type: 'shot'; fromX: number; fromY: number; toX: number; toY: number }
  | { type: 'swing'; x: number; y: number; facing: number }
  | { type: 'blood'; x: number; y: number }
  | { type: 'hurt'; damage: number }
  | { type: 'alarm'; x: number; y: number }
  /** Sonidos sueltos: la lógica solo avisa QUÉ sonó y DÓNDE; el audio decide cómo suena. */
  | { type: 'sfx'; name: SfxName; x: number; y: number }
  | { type: 'message'; text: string; tone?: 'info' | 'danger' | 'good' };

export interface Inventory {
  medkits: number;
  /** Baterías de repuesto para la linterna. */
  batteries: number;
}

export interface GameStats {
  kills: number;
  shots: number;
  hordes: number;
}

export interface GameState {
  status: 'playing' | 'won' | 'lost';
  /** Segundos de partida. */
  time: number;
  /** Número de paso lógico (60 por segundo). */
  tick: number;
  /** Estado del PRNG dinámico (ver random.ts). */
  rng: number;
  player: PlayerState;
  flashlight: FlashlightState;
  weapon: WeaponState;
  inventory: Inventory;
  loot: LootState;
  escape: EscapeState;
  zombies: Zombie[];
  nextZombieId: number;
  corpses: Corpse[];
  /** Segundos hasta la próxima horda. */
  hordeTimer: number;
  /** "Calor" del ruido: cada disparo suma; si se acumula mucho, llega una horda antes. */
  noiseHeat: number;
  stats: GameStats;
  events: GameEvent[];
}

export type SfxName =
  | 'step'
  | 'reload'
  | 'empty'
  | 'takedown'
  | 'spotted'
  | 'pickup'
  | 'horde'
  | 'helicopter'
  | 'medkit'
  | 'battery';
