// HUD en HTML encima del canvas: vida, arma, linterna, inventario, reloj y mensajes.
//
// Se actualiza en cada cuadro, pero solo toca el DOM cuando un valor cambió (escribir en el DOM
// es caro; comparar strings no).

import { BATTERY_SECONDS, LOW_BATTERY } from '../game/flashlight';
import { PISTOL_MAG } from '../game/combat';
import { PLAYER_MAX_HP } from '../game/player';
import type { GameEvent, GameState } from '../game/state';

const MESSAGE_SECONDS = 3.5;

export class Hud {
  private readonly root: HTMLElement;
  private readonly health: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly battery: HTMLElement;
  private readonly batteryText: HTMLElement;
  private readonly weapon: HTMLElement;
  private readonly items: HTMLElement;
  private readonly messages: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly cache = new Map<HTMLElement, string>();
  private readonly live: { el: HTMLElement; until: number }[] = [];

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'game-hud';
    this.root.innerHTML = `
      <div class="vignette"></div>
      <div class="messages"></div>
      <div class="prompt"></div>
      <div class="panel status">
        <div class="row"><span class="label">VIDA</span><div class="bar"><div class="fill health"></div></div><span class="num health-text"></span></div>
        <div class="row"><span class="label">LUZ</span><div class="bar"><div class="fill battery"></div></div><span class="num battery-text"></span></div>
        <div class="weapon"></div>
        <div class="items"></div>
      </div>`;
    document.body.appendChild(this.root);
    const q = (selector: string) => this.root.querySelector<HTMLElement>(selector)!;
    this.health = q('.health');
    this.healthText = q('.health-text');
    this.battery = q('.battery');
    this.batteryText = q('.battery-text');
    this.weapon = q('.weapon');
    this.items = q('.items');
    this.messages = q('.messages');
    this.vignette = q('.vignette');
    this.prompt = q('.prompt');
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /** Mensajes y sacudidas a partir de los eventos del paso. */
  handle(events: readonly GameEvent[], now: number): void {
    for (const event of events) {
      if (event.type === 'message') this.message(event.text, event.tone ?? 'info', now);
    }
  }

  message(text: string, tone: 'info' | 'danger' | 'good', now: number): void {
    // No repetir el mismo mensaje si ya está en pantalla.
    if (this.live.some((m) => m.el.textContent === text)) return;
    const el = document.createElement('div');
    el.className = `message ${tone}`;
    el.textContent = text;
    this.messages.appendChild(el);
    this.live.push({ el, until: now + MESSAGE_SECONDS });
    while (this.live.length > 4) this.live.shift()!.el.remove();
  }

  /** Texto de ayuda contextual (p. ej. "Mantén E para revisar el auto") y su barra de progreso. */
  setPrompt(text: string, progress?: number): void {
    const html = text
      ? `${text}${progress !== undefined ? `<div class="bar"><div class="fill" style="width:${Math.round(progress * 100)}%"></div></div>` : ''}`
      : '';
    this.set(this.prompt, html);
    this.prompt.style.display = text ? '' : 'none';
  }

  update(state: GameState, now: number): void {
    const p = state.player;
    const hp = Math.max(0, Math.ceil(p.hp));
    this.setStyle(this.health, `${(hp / PLAYER_MAX_HP) * 100}%`);
    this.health.classList.toggle('low', hp <= 30);
    this.set(this.healthText, String(hp));

    const light = state.flashlight;
    this.setStyle(this.battery, `${light.charge}%`);
    this.battery.classList.toggle('low', light.charge < LOW_BATTERY);
    const minutes = Math.ceil((light.charge / 100) * BATTERY_SECONDS);
    this.set(this.batteryText, light.on ? `${minutes}s` : 'off');

    const w = state.weapon;
    const weaponHtml =
      w.current === 'pistol'
        ? `<b>PISTOLA</b> ${w.reloadTimer > 0 ? '<i>recargando…</i>' : `${w.mag}/${PISTOL_MAG}`} <span class="dim">· reserva ${w.reserve}</span>`
        : `<b>BATE</b> <span class="dim">· pistola ${w.mag}/${PISTOL_MAG} + ${w.reserve}</span>`;
    this.set(this.weapon, weaponHtml);

    const inv = state.inventory;
    this.set(
      this.items,
      `botiquines <b>${inv.medkits}</b> [H] · baterías <b>${inv.batteries}</b> [B] · muertes <b>${state.stats.kills}</b>`,
    );

    // Viñeta roja al recibir daño, y permanente (suave) con poca vida.
    const hurt = Math.max(0, 1 - p.hurtTimer / 0.5);
    const lowHealth = hp <= 30 ? 0.35 + 0.15 * Math.sin(now * 5) : 0;
    this.vignette.style.opacity = String(Math.max(hurt, lowHealth));

    for (let i = this.live.length - 1; i >= 0; i--) {
      const m = this.live[i];
      const left = m.until - now;
      if (left <= 0) {
        m.el.remove();
        this.live.splice(i, 1);
      } else if (left < 0.6) {
        m.el.style.opacity = String(left / 0.6);
      }
    }
  }

  clearMessages(): void {
    for (const m of this.live) m.el.remove();
    this.live.length = 0;
  }

  private set(el: HTMLElement, html: string): void {
    if (this.cache.get(el) === html) return;
    this.cache.set(el, html);
    el.innerHTML = html;
  }

  private setStyle(el: HTMLElement, width: string): void {
    if (el.style.width !== width) el.style.width = width;
  }
}
