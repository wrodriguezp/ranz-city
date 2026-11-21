// HUD en HTML encima del canvas: vida, arma, linterna, inventario, reloj y mensajes.
//
// Se actualiza en cada cuadro, pero solo toca el DOM cuando un valor cambió (escribir en el DOM
// es caro; comparar strings no).

import { BATTERY_SECONDS, LOW_BATTERY } from '../game/flashlight';
import { GUNS, isGun, isSpecial, MELEES, ownedSpecial, WEAPON_ORDER } from '../game/combat';
import { THROW_NAMES, throwableCount } from '../game/explosives';
import { PLAYER_MAX_HP, STAMINA_MAX } from '../game/player';
import type { GameEvent, GameState } from '../game/state';

const MESSAGE_SECONDS = 3.5;

export class Hud {
  private readonly root: HTMLElement;
  private readonly health: HTMLElement;
  private readonly healthText: HTMLElement;
  private readonly battery: HTMLElement;
  private readonly batteryText: HTMLElement;
  private readonly stamina: HTMLElement;
  private readonly weapon: HTMLElement;
  private readonly items: HTMLElement;
  private readonly messages: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly evac: HTMLElement;
  private readonly stealth: HTMLElement;
  private readonly cache = new Map<HTMLElement, string>();
  private readonly live: { el: HTMLElement; until: number }[] = [];

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'game-hud';
    this.root.innerHTML = `
      <div class="vignette"></div>
      <div class="messages"></div>
      <div class="prompt"></div>
      <div class="stealth"></div>
      <div class="panel evac"></div>
      <div class="panel status">
        <div class="row"><span class="label">VIDA</span><div class="bar"><div class="fill health"></div></div><span class="num health-text"></span></div>
        <div class="row"><span class="label">LUZ</span><div class="bar"><div class="fill battery"></div></div><span class="num battery-text"></span></div>
        <div class="row"><span class="label">AIRE</span><div class="bar"><div class="fill stamina"></div></div><span class="num"></span></div>
        <div class="weapon"></div>
        <div class="items"></div>
      </div>`;
    document.body.appendChild(this.root);
    const q = (selector: string) => this.root.querySelector<HTMLElement>(selector)!;
    this.health = q('.health');
    this.healthText = q('.health-text');
    this.battery = q('.battery');
    this.batteryText = q('.battery-text');
    this.stamina = q('.stamina');
    this.weapon = q('.weapon');
    this.items = q('.items');
    this.messages = q('.messages');
    this.vignette = q('.vignette');
    this.prompt = q('.prompt');
    this.evac = q('.evac');
    this.stealth = q('.stealth');
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /** Mensaje informativo que no viene de la simulación (p. ej. sonido on/off). */
  flash(text: string): void {
    this.handle([{ type: 'message', text }], performance.now() / 1000);
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
    // El CSS lo oculta por defecto: hay que mostrarlo explícitamente ('' volvería a ocultarlo).
    this.prompt.style.display = text ? 'block' : 'none';
  }

  /** Reloj y salidas (panel bajo el minimapa). */
  setEvac(clock: string, lines: { text: string; tone: string }[]): void {
    this.set(
      this.evac,
      `<div class="clock">${clock}</div>` + lines.map((l) => `<div class="exit ${l.tone}">${l.text}</div>`).join(''),
    );
  }

  /** lampLight: luz de los faroles donde está el jugador (0..1), para avisar que está expuesto. */
  update(state: GameState, now: number, lampLight = 0): void {
    const p = state.player;
    const hp = Math.max(0, Math.ceil(p.hp));
    this.setStyle(this.health, `${(hp / PLAYER_MAX_HP) * 100}%`);
    this.health.classList.toggle('low', hp <= 30);
    this.set(this.healthText, String(hp));

    this.setStyle(this.stamina, `${(p.stamina / STAMINA_MAX) * 100}%`);
    this.stamina.classList.toggle('low', p.stamina < 30);

    const light = state.flashlight;
    this.setStyle(this.battery, `${light.charge}%`);
    this.battery.classList.toggle('low', light.charge < LOW_BATTERY);
    const minutes = Math.ceil((light.charge / 100) * BATTERY_SECONDS);
    this.set(this.batteryText, light.on ? `${minutes}s` : 'off');

    const w = state.weapon;
    const current = w.current;
    const melee = MELEES[w.melee];
    // Durabilidad del arma blanca (el bate no se rompe).
    const wear = melee.durability > 0 ? ` <span class="dim">· ${Math.ceil((w.durability / melee.durability) * 100)}%</span>` : '';
    let main: string;
    if (isGun(current)) {
      const gun = GUNS[current];
      const ammoType = gun.ammo;
      main = ammoType
        ? `<b>${gun.name}</b> ${w.reloadTimer > 0 ? '<i>recargando…</i>' : `${w.mags[current]}/${gun.mag}`} <span class="dim">· reserva ${w.ammo[ammoType]}</span>`
        : `<b>${gun.name}</b> ${w.mags[current]}/${gun.mag} <span class="dim">· se tira al vaciarse</span>`;
    } else {
      main = `<b>${melee.name}</b>${wear}`;
    }
    // La fila de armas: las que tienes, con su tecla; la de la mano, resaltada. Las tres
    // especiales comparten la tecla 5 (solo se puede tener una).
    const special = ownedSpecial(w);
    const slots = WEAPON_ORDER.filter((id) => !isSpecial(id))
      .map((id, i) => {
        if (!w.owned[id]) return `<span class="slot none">${i + 1}</span>`;
        const label = id === 'melee' ? melee.name.toLowerCase() : GUNS[id].name.toLowerCase();
        return `<span class="slot${id === current ? ' on' : ''}">${i + 1} ${label}</span>`;
      })
      .concat(
        special
          ? `<span class="slot special${special === current ? ' on' : ''}">5 ${GUNS[special].name.toLowerCase()}</span>`
          : `<span class="slot none">5</span>`,
      )
      .join('');
    this.set(this.weapon, `${main}<div class="slots">${slots}</div>`);

    const inv = state.inventory;
    this.set(
      this.items,
      `<b>[G] ${THROW_NAMES[inv.throwable]} ${throwableCount(inv, inv.throwable)}</b> <span class="dim">[T] cambiar · gr ${inv.grenades} · mol ${inv.molotovs} · pet ${inv.firecrackers} · radio ${inv.radios} · beng ${inv.flares}</span><br>botiquines <b>${inv.medkits}</b> [H] · baterías <b>${inv.batteries}</b> [B] · balas <b>${w.ammo.light}</b> · cartuchos <b>${w.ammo.shells}</b> · muertes <b>${state.stats.kills}</b>`,
    );

    // Sigilo: ¿cuántos te están persiguiendo? Si ninguno, estás oculto.
    let hunting = 0;
    let searching = 0;
    for (const z of state.zombies) {
      if (z.hp <= 0) continue;
      if (z.mode === 'chase' || z.mode === 'charge') hunting++;
      else if (z.mode === 'investigate' && state.time < z.hordeUntil) searching++;
    }
    const stealthHtml = hunting
      ? `<span class="seen">TE VIERON · ${hunting}</span>`
      : searching
        ? `<span class="searching">UNA HORDA TE BUSCA · ${searching}</span>`
        : lampLight > 0.35
          ? `<span class="exposed">BAJO UN FAROL · te ven de lejos</span>`
          : p.sneaking
            ? `<span class="hidden">SIGILO · oculto</span>`
            : `<span class="dim">oculto</span>`;
    this.set(this.stealth, stealthHtml);

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
