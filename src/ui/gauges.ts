// Indicadores pegados a la acción: lo que el jugador necesita saber de un vistazo, sin quitar los
// ojos del centro de la pantalla (en un monitor grande, las esquinas quedan muy lejos).
//
//  - Junto a la mira: el arma en la mano y sus balas (cargador grande, reserva chica). Es donde
//    miras al disparar, así que ahí se nota que te estás quedando sin balas.
//  - Bajo el personaje: tres barras finas (vida, aire y luz). Para ubicarlas proyectamos la
//    posición del jugador del mundo 3D a la pantalla, igual que los números de daño.
//
// Solo dibuja: lee el GameState y no lo modifica.

import * as THREE from 'three';
import { LOW_BATTERY } from '../game/flashlight';
import { GUNS, isGun, MELEES } from '../game/combat';
import { PLAYER_MAX_HP, STAMINA_MAX } from '../game/player';
import type { GameState } from '../game/state';

/** Separación de la etiqueta respecto del puntero, en píxeles (antes de escalar). */
const CURSOR_OFFSET_X = 26;
const CURSOR_OFFSET_Y = 14;
/** Las barras van un poco bajo los pies del jugador. */
const BARS_DROP = 34;

export class Gauges {
  private readonly root: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly bars: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly air: HTMLElement;
  private readonly light: HTMLElement;
  private readonly point = new THREE.Vector3();
  private lastCursor = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'gauges';
    this.root.innerHTML = `
      <div class="cursor-tag"></div>
      <div class="player-bars">
        <div class="pbar"><div class="pfill hp"></div></div>
        <div class="pbar"><div class="pfill air"></div></div>
        <div class="pbar"><div class="pfill light"></div></div>
      </div>`;
    document.body.appendChild(this.root);
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!;
    this.cursor = q('.cursor-tag');
    this.bars = q('.player-bars');
    this.hp = q('.hp');
    this.air = q('.air');
    this.light = q('.light');
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /**
   * mouse: puntero en coordenadas normalizadas (-1..1). px, py: posición interpolada del jugador.
   * scale: tamaño de la interfaz según la resolución.
   */
  update(state: GameState, camera: THREE.Camera, mouse: { x: number; y: number }, px: number, py: number, scale: number): void {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // --- Junto a la mira ---
    const mx = ((mouse.x + 1) / 2) * width;
    const my = ((1 - mouse.y) / 2) * height;
    this.cursor.style.transform = `translate(${Math.round(mx + CURSOR_OFFSET_X * scale)}px, ${Math.round(my + CURSOR_OFFSET_Y * scale)}px) scale(${scale})`;
    const html = this.cursorHtml(state);
    if (html !== this.lastCursor) {
      this.lastCursor = html;
      this.cursor.innerHTML = html;
    }

    // --- Bajo el personaje ---
    this.point.set(px, 0, py).project(camera);
    const sx = ((this.point.x + 1) / 2) * width;
    const sy = ((1 - this.point.y) / 2) * height + BARS_DROP * scale;
    this.bars.style.transform = `translate(${Math.round(sx)}px, ${Math.round(sy)}px) translateX(-50%) scale(${scale})`;

    const p = state.player;
    const hp = Math.max(0, p.hp) / PLAYER_MAX_HP;
    this.hp.style.width = `${hp * 100}%`;
    this.hp.classList.toggle('low', hp <= 0.3);
    const air = p.stamina / STAMINA_MAX;
    this.air.style.width = `${air * 100}%`;
    this.air.classList.toggle('low', air < 0.3);
    const fl = state.flashlight;
    this.light.style.width = `${fl.charge}%`;
    this.light.classList.toggle('low', fl.charge < LOW_BATTERY);
    this.light.classList.toggle('off', !fl.on);
  }

  private cursorHtml(state: GameState): string {
    const w = state.weapon;
    if (!isGun(w.current)) {
      const melee = MELEES[w.melee];
      const wear = melee.durability > 0 ? ` <span class="sub">${Math.ceil((w.durability / melee.durability) * 100)}%</span>` : '';
      return `<div class="name">${melee.name}</div><div class="melee">${wear || '<span class="sub">∞</span>'}</div>`;
    }
    const gun = GUNS[w.current];
    const mag = w.mags[w.current];
    const reserve = gun.ammo ? w.ammo[gun.ammo] : null;
    const empty = mag === 0 && (reserve === null || reserve === 0);
    const low = mag <= Math.max(1, Math.floor(gun.mag * 0.25));
    let ammo: string;
    if (w.reloadTimer > 0) {
      // Barra de recarga: de a 5 % para no reescribir el DOM en cada cuadro.
      const done = Math.round((1 - w.reloadTimer / gun.reload) * 20) * 5;
      ammo = `<span class="reload">RECARGANDO</span><div class="rbar"><div class="rfill" style="width:${done}%"></div></div>`;
    }
    else if (empty) ammo = `<span class="out">SIN BALAS</span>`;
    else ammo = `<span class="mag${low ? ' low' : ''}">${mag}</span>${reserve !== null ? `<span class="sub"> / ${reserve}</span>` : ''}`;
    const hint = !empty && mag === 0 && w.reloadTimer <= 0 ? `<div class="hint">[R] recargar</div>` : '';
    return `<div class="name">${gun.name}</div><div class="ammo">${ammo}</div>${hint}`;
  }
}

/** Escala de la interfaz: 1 a 1080 p, más grande en 1440 p o 4K (con tope para no tapar el juego). */
export function uiScale(): number {
  return Math.min(2, Math.max(1, window.innerHeight / 1000));
}
