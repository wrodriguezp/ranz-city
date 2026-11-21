// Iluminación de noche.
//
// Tres capas:
//  1. Luz ambiental casi nula (cielo y luna): alcanza para adivinar la forma de los edificios
//     y leer el laberinto desde arriba, pero no para ver qué hay en la calle.
//  2. La linterna: un SpotLight (cono de luz) que sale del pecho del jugador hacia el mouse.
//     Proyecta sombras reales: Three.js dibuja la escena desde la linterna a un "mapa de sombras"
//     (una textura de profundidades) y, al pintar cada píxel, compara su distancia con ese mapa.
//     Si algo más cercano a la luz lo tapa, queda en sombra. Por eso las esquinas de los edificios
//     cortan el cono y la calle de al lado queda negra: no sabes qué hay doblando la esquina.
//  3. Un "aura" tenue alrededor del jugador, para que se vea a sí mismo y a lo que tiene encima
//     incluso con la linterna apagada.
//
// Detalle de rendimiento: Three.js compila un shader distinto según CUÁNTAS luces hay. Por eso
// el fogonazo del disparo es una luz que siempre existe con intensidad 0, en vez de crearla y
// borrarla en cada disparo (eso recompilaría los shaders y daría tirones).

import * as THREE from 'three';

const FLASHLIGHT_INTENSITY = 160;
const FLASHLIGHT_RANGE = 30;
/** Altura del pecho, desde donde sale la luz. */
const FLASHLIGHT_HEIGHT = 1.3;

export class NightLighting {
  readonly flashlight: THREE.SpotLight;
  readonly muzzle: THREE.PointLight;
  /** Luz de las explosiones: existe siempre (intensidad 0) por lo mismo que el fogonazo. */
  private readonly boom: THREE.PointLight;
  private boomTimer = 0;
  private boomPower = 0;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly moon: THREE.DirectionalLight;
  private readonly aura: THREE.PointLight;
  private muzzleTimer = 0;

  constructor(scene: THREE.Scene) {
    this.hemisphere = new THREE.HemisphereLight(0x50618a, 0x08080a, 0.35);
    this.moon = new THREE.DirectionalLight(0x8a9cd0, 0.25);
    this.moon.position.set(-40, 100, -60);

    this.flashlight = new THREE.SpotLight(0xfff0d0, FLASHLIGHT_INTENSITY, FLASHLIGHT_RANGE, 0.5, 0.45, 1.0);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(2048, 2048);
    this.flashlight.shadow.camera.near = 0.3;
    this.flashlight.shadow.camera.far = FLASHLIGHT_RANGE;
    this.flashlight.shadow.bias = -0.0004;
    this.flashlight.shadow.normalBias = 0.03;

    this.aura = new THREE.PointLight(0xffd9a8, 4, 5.5, 1.4);
    this.muzzle = new THREE.PointLight(0xffc060, 0, 14, 1.3);
    this.boom = new THREE.PointLight(0xff8a30, 0, 26, 1.2);

    scene.add(this.hemisphere, this.moon, this.flashlight, this.flashlight.target, this.aura, this.muzzle, this.boom);
  }

  /** En la vista de revisión queremos ver la ciudad completa: luz de día. */
  setDaylight(day: boolean): void {
    this.hemisphere.intensity = day ? 2.2 : 0.35;
    this.hemisphere.color.setHex(day ? 0xdfe8ff : 0x50618a);
    this.moon.intensity = day ? 1.4 : 0.25;
  }

  /** power: 0..1 (sale de flashlightPower, incluye el parpadeo por batería baja). */
  update(x: number, y: number, facing: number, power: number, dt: number): void {
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    this.flashlight.position.set(x + cos * 0.45, FLASHLIGHT_HEIGHT, y + sin * 0.45);
    // El cono apunta un poco hacia abajo: el centro toca el suelo a unos 9 tiles.
    this.flashlight.target.position.set(x + cos * 9, 0, y + sin * 9);
    this.flashlight.intensity = FLASHLIGHT_INTENSITY * power;
    // Con poca batería el alcance también se acorta.
    this.flashlight.distance = FLASHLIGHT_RANGE * (0.55 + 0.45 * Math.min(1, power));

    this.aura.position.set(x, 2.2, y);

    this.muzzleTimer = Math.max(0, this.muzzleTimer - dt);
    this.muzzle.intensity = this.muzzleTimer > 0 ? 60 * (this.muzzleTimer / 0.06) : 0;
    // La explosión ilumina la cuadra entera por un instante: también se ven los zombies.
    this.boomTimer = Math.max(0, this.boomTimer - dt);
    const t = this.boomTimer / 0.45;
    this.boom.intensity = this.boomPower * t * t;
  }

  /** Destello de una explosión en (x, y). */
  blast(x: number, y: number, radius: number): void {
    this.boom.position.set(x, 2.5, y);
    this.boom.distance = radius * 5;
    this.boomPower = 120 + radius * 40;
    this.boomTimer = 0.45;
  }

  /** Fogonazo de un disparo en (x, y). */
  flash(x: number, y: number): void {
    this.muzzle.position.set(x, 1.3, y);
    this.muzzleTimer = 0.06;
  }
}
