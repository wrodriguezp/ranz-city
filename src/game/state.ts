import type { Pickup } from './pickups';
// Estado DINÁMICO de la partida: todo lo que cambia mientras se juega.
//
// Regla del proyecto: la seed genera solo el mundo estático (City). Esto es lo otro, y se guarda
// como datos planos (números, strings, arreglos), sin clases ni referencias a Three.js.
// Así se puede serializar con JSON: guardar la partida, o en el futuro multijugador, que el host
// mande este estado a los demás jugadores.

import type { WeaponId, WeaponState } from './combat';
import type { EscapeState } from './escape';
import type { FlashlightState } from './flashlight';
import type { LootState } from './loot';
import type { PlayerState } from './player';
import type { Weather } from '../world/weather';
import type { LootItem } from '../world/props';

/**
 * Tipos de infectado:
 *  walker   el común: lento, en grupo es peligroso
 *  runner   corredor: rápido y frágil, castiga quedarse quieto
 *  bloater  hinchado: lento y duro; al morir REVIENTA y daña a todo lo que esté cerca
 *           (zombies incluidos: matarlo en medio de una horda es una buena idea)
 *  screamer gritón: si te ve, grita y llama a una horda; conviene matarlo primero
 *  spitter  escupidor: se queda a distancia y te escupe ácido que deja un charco
 *  tank     el jefe del paso obligado: embiste y lanza escombros
 */
export type ZombieKind = 'walker' | 'runner' | 'bloater' | 'screamer' | 'spitter' | 'tank' | 'sleeper';

/**
 * Miembros perdidos de un zombie, como máscara de bits (un número: se serializa sin problema).
 * Sin un brazo pega más débil; sin los dos no puede atacar (solo empuja). Sin piernas se arrastra.
 */
export const LIMB_ARM_L = 1;
export const LIMB_ARM_R = 2;
export const LIMB_LEGS = 4;

/**
 * Máquina de estados de un zombie:
 *  idle        quieto, balanceándose
 *  wander      deambula sin rumbo
 *  investigate va hacia un ruido que escuchó
 *  chase       persigue al jugador (lo está viendo, o lo vio hace muy poco)
 *  return      (tanque) vuelve a su puesto tras perder al jugador
 *  charge      (tanque) embestida en línea recta
 *  stunned     aturdido después de embestir
 *  throw       (tanque) preparando el lanzamiento de un escombro
 */
/**
 * Cómo persigue cada zombie (para que una horda no sea una fila india predecible):
 *  chaser   perseguidor: va directo hacia ti
 *  surround envolvente: al acercarse se abre hacia un costado; entre varios te rodean
 *  flanker  flanqueador: va hacia donde VAS a estar (por otra calle si hace falta) y te corta el paso
 *  ambusher acechador: quieto en un cruce, agazapado; no se mueve por ruidos lejanos y cuando te ve
 *           de cerca se lanza con un arranque de velocidad
 */
export type ZombieRole = 'chaser' | 'surround' | 'flanker' | 'ambusher';

export type ZombieMode = 'idle' | 'wander' | 'investigate' | 'chase' | 'return' | 'charge' | 'stunned' | 'throw' | 'leap';

export interface Zombie {
  id: number;
  kind: ZombieKind;
  role: ZombieRole;
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
  /**
   * Hasta cuándo es parte de una horda. La horda NO sabe dónde estás: va al último ruido fuerte
   * o a la zona donde te oyeron, y peina el área hasta que se le acaba el tiempo.
   */
  hordeUntil: number;
  /**
   * Hasta cuándo te CAZA: sabe dónde estás aunque no te vea (va por el campo de flujo hacia ti)
   * y no se distrae con ruidos. Lo usan las oleadas de la defensa final y los especiales
   * enfurecidos (el tanque que te vio, la sonámbula despierta).
   */
  huntUntil: number;
  homeX: number;
  homeY: number;
  /**
   * Altura sobre el suelo (tiles) y velocidad vertical: una explosión o la embestida del tanque
   * lo LANZA por el aire. El mundo sigue siendo 2D; la altura es un dato más, como el empujón.
   */
  air: number;
  airV: number;
  /**
   * Saltando un obstáculo bajo (valla, barricada, auto): va de (fx, fy) a (tx, ty) en dur
   * segundos, por encima, sin colisión. t = segundos transcurridos.
   */
  vault?: {
    t: number;
    dur: number;
    fx: number;
    fy: number;
    tx: number;
    ty: number;
    /** Altura del arco (por defecto la de saltar una valla) y altura de partida. */
    h?: number;
    z0?: number;
    /**
     * Qué clase de vuelo es: 'slam' = el salto del tanque (aplasta al caer); 'thrown' = un zombie
     * que el tanque lanzó; 'held' = un zombie que el tanque tiene agarrado (by = id del tanque).
     */
    kind?: 'slam' | 'thrown' | 'held' | 'drop';
    by?: number;
  };
  /** En llamas: un corredor que arde sin consumirse (inmune al fuego) y quema lo que toca. */
  blazing?: boolean;
  /** Parado en un techo a esta altura: espera a que pases cerca para saltarte encima. */
  perch?: number;
  /** El tanque carga algo para tirarlo: un barril o un zombie (su id). Sin nada, es una roca. */
  carry?: 'barrel' | number;
  /** Segundos hasta que el tanque pueda volver a saltar. */
  leapCd?: number;
  /** Viene en una oleada de la defensa final (no suelta loot: para eso está la caja de munición). */
  wave?: boolean;
  /** Número de la horda en la que vino (0 = no vino en una horda). */
  horde?: number;
  /** Soldado del retén militar (más vida; casco y chaleco al dibujarlo). */
  armored?: boolean;
  /**
   * La sonámbula: qué tan cerca está de despertar (0..1). Sube con tus pasos, tu linterna y los
   * ruidos; baja sola si la dejas tranquila. Al llegar a 1, despierta (ver zombies.ts).
   */
  agitation?: number;
  /** Cuándo se avisó por última vez en pantalla que hay una sonámbula cerca. */
  hintAt?: number;
  /** Enfriamiento de la habilidad especial (grito, lanzamiento del tanque). */
  ability: number;
  /** Miembros perdidos (ver LIMB_*). */
  limbs: number;
  /** Segundos que le quedan ardiendo (molotov, lanzallamas). */
  burn: number;
}

/**
 * Peligro en el suelo: fuego (molotov, lanzallamas) o ácido (escupidor). Un círculo que daña a
 * quien lo pisa mientras dure. El fuego también prende a los zombies.
 */
export interface Hazard {
  kind: 'fire' | 'acid';
  x: number;
  y: number;
  radius: number;
  timer: number;
  maxTimer: number;
}

/**
 * Señuelo: algo que hace ruido una y otra vez en un lugar (petardos, una radio, la alarma de un
 * auto, la bengala). Cada "pulso" es un makeNoise: los zombies van ahí y no a ti.
 */
export interface Lure {
  kind: 'firecracker' | 'radio' | 'alarm' | 'flare';
  x: number;
  y: number;
  timer: number;
  /** Segundos hasta el próximo pulso de ruido. */
  pulse: number;
}

/** Suministro aéreo pedido con una bengala: cae en paracaídas y se revisa como una caja. */
export interface SupplyDrop {
  x: number;
  y: number;
  /** Segundos que faltan para que toque el suelo (mientras, se ve bajando). */
  fall: number;
  opened: boolean;
  loot: LootItem[];
}

/**
 * Algo que vuela: una granada del jugador o un escombro del tanque. Se mueve en 2D por la
 * grilla (rebota contra las paredes) y tiene una altura z con gravedad, solo para el arco.
 */
export interface Projectile {
  kind: ProjectileKind;
  /** Dónde va a caer (la roca del tanque marca ese punto en el suelo para que la esquives). */
  targetX: number;
  targetY: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Segundos hasta explotar (la granada); la roca revienta al tocar el suelo. */
  fuse: number;
  /** ¿Ya tocó el suelo una vez? (el primer rebote hace ruido). */
  landed: boolean;
}

export type ProjectileKind = 'grenade' | 'rock' | 'molotov' | 'firecracker' | 'radio' | 'flare' | 'acid' | 'rocket' | 'barrel';
export type BlastName = 'grenade' | 'barrel' | 'bloater' | 'rock' | 'rocket' | 'slam';
/** Lo que se lanza con G (T cambia cuál). */
export type ThrowableId = 'grenade' | 'molotov' | 'firecracker' | 'radio' | 'flare';
export const THROWABLES: ThrowableId[] = ['grenade', 'molotov', 'firecracker', 'radio', 'flare'];

export interface Corpse {
  x: number;
  y: number;
  facing: number;
  kind: ZombieKind;
}

/** Sucesos de un paso, para que el render y el HUD reaccionen (efectos, mensajes). No se guardan. */
export type GameEvent =
  /** hit: qué paró la bala, para chispas en la pared o sangre en el zombie. */
  | {
      type: 'shot';
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      hit: 'zombie' | 'wall' | 'none';
      weapon: WeaponId;
      /** Primer perdigón de un disparo (para que la escopeta suene una vez y no nueve). */
      first: boolean;
    }
  | { type: 'swing'; x: number; y: number; facing: number }
  | { type: 'blood'; x: number; y: number }
  /**
   * Un golpe que conectó: el render lo usa para salpicar sangre, soltar trozos, mostrar el
   * número de daño y sacudir la cámara. dirX/dirY: hacia dónde fue empujado.
   */
  | {
      type: 'hit';
      x: number;
      y: number;
      dirX: number;
      dirY: number;
      damage: number;
      killed: boolean;
      /** Muerte violenta (crítico, escopeta de cerca, explosión): el cuerpo revienta. */
      gib: boolean;
      crit: boolean;
      kind: ZombieKind;
    }
  /** Un miembro arrancado: el render suelta la pieza volando. side: -1 izquierda, 1 derecha. */
  | { type: 'limb'; x: number; y: number; dirX: number; dirY: number; part: 'arm' | 'legs' | 'head'; side: number; kind: ZombieKind; facing: number }
  /** Llamarada del lanzallamas (un chorro por paso mientras se dispara). */
  | { type: 'flame'; x: number; y: number; toX: number; toY: number }
  /** Un arma cuerpo a cuerpo se rompió, o se soltó un arma especial vacía. */
  | { type: 'drop'; what: string }
  | { type: 'hurt'; damage: number }
  | { type: 'alarm'; x: number; y: number }
  | { type: 'explosion'; x: number; y: number; radius: number; kind: BlastName }
  | { type: 'barrel'; id: number }
  /** Sonidos sueltos: la lógica solo avisa QUÉ sonó y DÓNDE; el audio decide cómo suena. */
  | { type: 'sfx'; name: SfxName; x: number; y: number }
  | { type: 'message'; text: string; tone?: 'info' | 'danger' | 'good' };

export interface Inventory {
  medkits: number;
  /** Baterías de repuesto para la linterna. */
  batteries: number;
  grenades: number;
  molotovs: number;
  firecrackers: number;
  radios: number;
  flares: number;
  /** Lo que se lanza con G. */
  throwable: ThrowableId;
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
  /** Clima de la noche (viene de la seed; se copia aquí porque cambia el oído y la vista). */
  weather: Weather;
  player: PlayerState;
  flashlight: FlashlightState;
  weapon: WeaponState;
  inventory: Inventory;
  loot: LootState;
  escape: EscapeState;
  zombies: Zombie[];
  nextZombieId: number;
  projectiles: Projectile[];
  /** barrels[id] = true si ese barril (city.barrels) ya explotó. */
  barrelsBlown: boolean[];
  /** Explosiones a punto de salir (cadenas de barriles, hinchados): ver explosives.ts. */
  pendingBlasts: { x: number; y: number; kind: BlastName; delay: number }[];
  hazards: Hazard[];
  lures: Lure[];
  drops: SupplyDrop[];
  /** Lo que soltaron los zombies al morir (ver pickups.ts). */
  pickups: Pickup[];
  /** alarmsFired[id] = true si la alarma de ese auto (city.props[id]) ya sonó. */
  alarmsFired: boolean[];
  corpses: Corpse[];
  /** Segundos hasta la próxima horda. */
  hordeTimer: number;
  /** "Calor" del ruido: cada disparo suma; si se acumula mucho, llega una horda antes. */
  noiseHeat: number;
  /**
   * El director de las hordas (como el de L4D2): reparte tensión y respiro.
   * relaxUntil: hasta cuándo el ruido no trae hordas (después de una, toca respirar).
   * reserve: cuántos zombies de horda le quedan a la ciudad (es finita: las hordas se acaban).
   * horde: número de la última horda; sus zombies llevan ese número en Zombie.horde.
   * hordeSize: cuántos trajo (para saber si la despejaste).
   */
  director: { relaxUntil: number; reserve: number; horde: number; hordeSize: number; warnedEmpty: boolean };
  /**
   * Alerta en cadena: si 3 o más zombies te persiguen, gruñen y ese ruido llama a los de alrededor.
   * timer: segundos hasta el próximo gruñido; told: cuándo se avisó por última vez en pantalla.
   */
  /** told: último aviso de la alerta en cadena; acidTold: último aviso de "estás en el ácido". */
  alert: { timer: number; told: number; acidTold: number; roofTold: number };
  /** El último ruido fuerte (disparo, alarma, explosión): las hordas van ahí, no a ti. */
  lastNoise: { x: number; y: number; time: number };
  stats: GameStats;
  events: GameEvent[];
}

export type SfxName =
  | 'murmur'
  | 'step'
  | 'sneakstep'
  | 'reload'
  | 'reloaded'
  | 'empty'
  | 'takedown'
  | 'spotted'
  | 'pickup'
  | 'horde'
  | 'helicopter'
  | 'medkit'
  | 'battery'
  | 'throw'
  | 'bounce'
  | 'scream'
  | 'weapon'
  | 'switch'
  | 'roar'
  | 'pack'
  | 'dash'
  | 'tired'
  | 'break'
  | 'sever'
  | 'ignite'
  | 'glass'
  | 'firecracker'
  | 'radio'
  | 'spit'
  | 'plane'
  | 'landing'
  | 'rocket'
  | 'flame'
  | 'minigun';
