// Cámara de juego: ortográfica, con ángulo isométrico fijo, que sigue al jugador.

import * as THREE from 'three';

/** Cuántos tiles caben en el alto de la pantalla. Más chico = más cerca. La rueda lo cambia. */
const VIEW_HEIGHT = 28;
const MIN_VIEW_HEIGHT = 18;
const MAX_VIEW_HEIGHT = 40;
/** Giro horizontal de la cámara: 45° es el ángulo isométrico clásico. */
const YAW = Math.PI / 4;
/**
 * Inclinación respecto del suelo. La isometría "pura" usa ~35°; usamos 55° (más desde arriba)
 * para que los edificios altos tapen menos al personaje y se vea más de la calle.
 */
const PITCH = THREE.MathUtils.degToRad(55);
const DISTANCE = 120;
/** Qué fracción de la distancia al mouse se adelanta la cámara, y hasta cuántos tiles como máximo. */
const LOOK_AHEAD = 0.3;
const MAX_LOOK_AHEAD = 7;
/** Rapidez del suavizado: más alto = la cámara alcanza antes su objetivo. */
const FOLLOW_SHARPNESS = 8;

export class GameCamera {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  /** Punto del suelo (en tiles) que la cámara está mirando. */
  private readonly focus = new THREE.Vector2();
  /** Vector desde el punto enfocado hasta la cámara. */
  private readonly offset: THREE.Vector3;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly hit = new THREE.Vector3();
  private viewHeight = VIEW_HEIGHT;
  private aspect = 1;
  /**
   * "Trauma" de la sacudida, de 0 a 1. Cada golpe o explosión suma; baja solo con el tiempo.
   * El desplazamiento es trauma², así los golpes chicos casi no mueven la cámara y los grandes
   * la sacuden fuerte (truco clásico de "game feel").
   */
  private trauma = 0;
  private readonly jitter = new THREE.Vector2();

  constructor() {
    // Coordenadas esféricas: el offset apunta "hacia atrás y arriba" desde el foco.
    this.offset = new THREE.Vector3(
      Math.cos(PITCH) * Math.sin(YAW),
      Math.sin(PITCH),
      Math.cos(PITCH) * Math.cos(YAW),
    ).multiplyScalar(DISTANCE);
    this.resize(window.innerWidth / window.innerHeight);
  }

  resize(aspect: number): void {
    this.aspect = aspect;
    const h = this.viewHeight;
    this.camera.left = (-h * aspect) / 2;
    this.camera.right = (h * aspect) / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Acercar o alejar (rueda del mouse). En una cámara ortográfica no hay "distancia" que cambie
   * el tamaño: se agranda o achica la ventana de visión (cuántos tiles caben en pantalla).
   */
  zoom(steps: number): void {
    this.viewHeight = THREE.MathUtils.clamp(this.viewHeight * Math.pow(1.1, steps), MIN_VIEW_HEIGHT, MAX_VIEW_HEIGHT);
    this.resize(this.aspect);
  }

  /** Suma una sacudida (0..1). Solo visual: no toca la simulación. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Dirección normalizada desde la escena hacia la cámara (paralela a todos los rayos de visión). */
  toCameraDirection(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.offset).normalize();
  }

  /** Coloca la cámara de golpe sobre un punto, sin suavizado (al aparecer o cambiar de ciudad). */
  snapTo(x: number, y: number): void {
    this.focus.set(x, y);
    this.apply();
  }

  /**
   * Sigue al jugador, adelantándose un poco hacia donde apunta.
   * El suavizado usa 1 − e^(−k·dt) en vez de un factor fijo: así la cámara se mueve igual de suave
   * sin importar los FPS (con un factor fijo, a 144 FPS seguiría más rápido que a 60).
   */
  follow(playerX: number, playerY: number, aimX: number, aimY: number, dt: number): void {
    const lead = new THREE.Vector2(aimX - playerX, aimY - playerY).multiplyScalar(LOOK_AHEAD);
    if (lead.length() > MAX_LOOK_AHEAD) lead.setLength(MAX_LOOK_AHEAD);
    const t = 1 - Math.exp(-FOLLOW_SHARPNESS * dt);
    this.focus.lerp(new THREE.Vector2(playerX + lead.x, playerY + lead.y), t);
    this.trauma = Math.max(0, this.trauma - 1.8 * dt);
    const strength = this.trauma * this.trauma * 0.9;
    this.jitter.set((Math.random() * 2 - 1) * strength, (Math.random() * 2 - 1) * strength);
    this.apply();
  }

  /**
   * Direcciones de la PANTALLA expresadas en el suelo del mundo (en tiles).
   * "up" es hacia dónde se aleja la cámara al mirar: el opuesto del offset, aplanado al suelo.
   * "right" es up girado 90°. Con esto, W siempre mueve hacia arriba en la pantalla
   * aunque en el mapa eso sea una diagonal.
   */
  screenAxesOnGround(): { upX: number; upY: number; rightX: number; rightY: number } {
    const upX = -this.offset.x;
    const upY = -this.offset.z;
    const length = Math.hypot(upX, upY);
    const ux = upX / length;
    const uy = upY / length;
    // Girar (ux, uy) 90° para obtener la derecha. Ejemplo con YAW = 45°:
    // up = (−0.71, −0.71) y right = (0.71, −0.71), que en pantalla es justo hacia la derecha.
    return { upX: ux, upY: uy, rightX: -uy, rightY: ux };
  }

  /**
   * Convierte la posición del mouse (NDC) en un punto del suelo, en tiles.
   * Lanza un rayo desde la cámara a través del mouse y busca dónde corta el plano y = 0.
   * Con cámara ortográfica todos los rayos son paralelos (lo que cambia es su punto de origen).
   */
  groundPointUnderMouse(ndcX: number, ndcY: number): { x: number; y: number } | undefined {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const point = this.raycaster.ray.intersectPlane(this.ground, this.hit);
    return point ? { x: point.x, y: point.z } : undefined;
  }

  private apply(): void {
    const fx = this.focus.x + this.jitter.x;
    const fy = this.focus.y + this.jitter.y;
    this.camera.position.set(fx + this.offset.x, this.offset.y, fy + this.offset.z);
    this.camera.lookAt(fx, 0, fy);
    this.camera.updateMatrixWorld();
  }
}
