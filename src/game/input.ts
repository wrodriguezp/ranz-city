// Estado de la entrada (teclado y mouse).
// Usamos event.code ("KeyW") en vez de event.key ("w"): code es la POSICIÓN física de la tecla,
// así WASD funciona igual con teclado español, inglés o AZERTY.

export class Input {
  private readonly down = new Set<string>();
  /** Posición del mouse en coordenadas normalizadas de pantalla (NDC): de -1 a 1 en cada eje. */
  readonly mouse = { x: 0, y: 0 };

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => this.down.add(e.code));
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    // Si la ventana pierde el foco con una tecla apretada, nunca llega el keyup: soltamos todo.
    window.addEventListener('blur', () => this.down.clear());
    target.addEventListener('pointermove', (e) => {
      const rect = target.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    });
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /**
   * Dirección de movimiento pedida en ejes de PANTALLA: x = derecha, y = arriba.
   * Viene normalizada, así que moverse en diagonal no es más rápido que en línea recta.
   */
  screenMove(): { x: number; y: number } {
    const x = (this.isDown('KeyD') ? 1 : 0) - (this.isDown('KeyA') ? 1 : 0);
    const y = (this.isDown('KeyW') ? 1 : 0) - (this.isDown('KeyS') ? 1 : 0);
    const length = Math.hypot(x, y);
    return length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
  }
}
