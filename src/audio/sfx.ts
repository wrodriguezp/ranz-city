// Efectos de sonido sintetizados con WebAudio: no hay archivos de audio, todo se arma con
// osciladores y ruido filtrado (igual que los gráficos usan formas básicas en vez de modelos).
//
// Cómo se "fabrica" un sonido:
//  - Un disparo es un estallido de RUIDO blanco que se apaga en ~0.2 s, más un golpe grave
//    (una senoidal que baja de 150 a 40 Hz): el "pum" que se siente en el pecho.
//  - Un gruñido de zombie es una onda diente de sierra grave (70-110 Hz) con vibrato, pasada
//    por un filtro pasa-bajos: suena a garganta.
//  - La "envolvente" (cómo sube y baja el volumen en el tiempo) es lo que más define cada sonido.
//
// El audio vive del lado del render: la lógica solo emite eventos ("sonó un disparo en x,y") y
// aquí se decide el volumen según la distancia y el paneo izquierda/derecha según la pantalla.

import type { GameEvent } from '../game/state';

export interface Listener {
  x: number;
  y: number;
  /** Eje "derecha de la pantalla" proyectado al suelo, para panear. */
  rightX: number;
  rightY: number;
}

/** Más allá de esto (tiles) un sonido ya no se oye. */
const HEARING = 40;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;
  /** Para no saturar: último momento en que sonó cada tipo de sonido. */
  private readonly last = new Map<string, number>();
  private nextAmbient = 4;
  private nextHeartbeat = 0;

  constructor() {
    // Los navegadores solo dejan crear audio después de una interacción del usuario.
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.6;
    return this.muted;
  }

  private ensure(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    // Un compresor al final evita que 20 sonidos juntos revienten los parlantes.
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    // Un segundo de ruido blanco, reutilizado por todos los sonidos "sucios".
    const length = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  /** Procesa los eventos de los pasos de este cuadro. */
  handle(events: readonly GameEvent[], l: Listener): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          // Un perdigón de escopeta no suena: suena el disparo entero (el primero).
          if (!e.first) break;
          if (e.weapon === 'shotgun') this.shotgun(this.place(e.fromX, e.fromY, l, 1.1));
          else if (e.weapon === 'smg') this.smg(this.place(e.fromX, e.fromY, l, 0.75));
          // La minigun dispara 22 veces por segundo: cada disparo es casi un click grave.
          else if (e.weapon === 'minigun') {
            if (this.throttle('minigun', 0.04)) this.minigun(this.place(e.fromX, e.fromY, l, 0.7));
          }
          else this.shot(this.place(e.fromX, e.fromY, l, 1));
          break;
        case 'explosion':
          if (e.kind === 'bloater') this.splat(this.place(e.x, e.y, l, 1, 50));
          else this.explosion(this.place(e.x, e.y, l, e.kind === 'rock' ? 0.8 : e.kind === 'rocket' ? 1.5 : 1.3, 80), e.kind === 'rock');
          break;
        case 'swing':
          this.swing(this.place(e.x, e.y, l, 0.7));
          break;
        case 'blood':
          if (this.throttle('hit', 0.04)) this.hit(this.place(e.x, e.y, l, 0.8));
          break;
        case 'hurt':
          if (this.throttle('hurt', 0.25)) this.hurt(this.place(l.x, l.y, l, 0.9));
          break;
        case 'alarm':
          // El señuelo de alarma avisa cada segundo; el sonido dura casi 4: no encimarlos.
          if (this.throttle(`alarm${Math.round(e.x)},${Math.round(e.y)}`, 3.7)) this.alarm(this.place(e.x, e.y, l, 0.8, 60));
          break;
        case 'flame':
          if (this.throttle('flame', 0.09)) this.flame(this.place(e.x, e.y, l, 0.6));
          break;
        case 'sfx':
          this.named(e.name, e.x, e.y, l);
          break;
      }
    }
  }

  /**
   * Sonidos de ambiente que no salen de la lógica: gruñidos de zombies cercanos cada tanto
   * (para que se sientan aunque no se vean) y el latido con poca vida.
   */
  ambient(dt: number, l: Listener, zombies: readonly { x: number; y: number; hp: number }[], hp: number): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this.nextAmbient -= dt;
    if (this.nextAmbient <= 0) {
      // Un zombie al azar entre los cercanos.
      const near = zombies.filter((z) => z.hp > 0 && Math.abs(z.x - l.x) < 18 && Math.abs(z.y - l.y) < 18);
      if (near.length) {
        const z = near[Math.floor(Math.random() * near.length)];
        this.groan(this.place(z.x, z.y, l, 0.55, 22));
      }
      // Más zombies cerca = gruñidos más seguidos.
      this.nextAmbient = 1.2 + Math.random() * 3 / Math.max(1, near.length / 4);
    }
    this.nextHeartbeat -= dt;
    if (hp > 0 && hp <= 30 && this.nextHeartbeat <= 0) {
      this.heartbeat();
      this.nextHeartbeat = 0.55 + hp / 60;
    }
  }

  // --- Ubicación -----------------------------------------------------------------------------

  /** Volumen por distancia y paneo por el lado de la pantalla. Devuelve el nodo de entrada. */
  private place(x: number, y: number, l: Listener, volume: number, hearing = HEARING): AudioNode | null {
    const ctx = this.ctx!;
    const dx = x - l.x;
    const dy = y - l.y;
    const d = Math.hypot(dx, dy);
    if (d > hearing) return null;
    // Caída suave: cerca casi al máximo, lejos se pierde.
    const g = volume * Math.pow(1 - d / hearing, 1.6);
    const gain = ctx.createGain();
    gain.gain.value = g;
    const pan = ctx.createStereoPanner();
    pan.pan.value = d < 0.5 ? 0 : Math.max(-1, Math.min(1, ((dx * l.rightX + dy * l.rightY) / d) * Math.min(1, d / 8)));
    gain.connect(pan).connect(this.master!);
    return gain;
  }

  private throttle(key: string, seconds: number): boolean {
    const now = this.ctx!.currentTime;
    if (now - (this.last.get(key) ?? -99) < seconds) return false;
    this.last.set(key, now);
    return true;
  }

  private named(name: string, x: number, y: number, l: Listener): void {
    switch (name) {
      case 'step':
        this.step(this.place(x, y, l, 0.18));
        break;
      case 'reload':
        this.click(this.place(x, y, l, 0.5), 0, 2200);
        this.click(this.place(x, y, l, 0.6), 1.25, 1500);
        break;
      case 'empty':
        this.click(this.place(x, y, l, 0.6), 0, 3000);
        break;
      case 'takedown':
        this.hit(this.place(x, y, l, 1));
        this.crunch(this.place(x, y, l, 0.7));
        break;
      case 'spotted':
        if (this.throttle('spotted', 0.5)) this.groan(this.place(x, y, l, 0.9, 30), true);
        break;
      case 'pickup':
        this.blip(this.place(x, y, l, 0.35), [660, 990]);
        break;
      case 'medkit':
        this.blip(this.place(x, y, l, 0.35), [523, 659, 784]);
        break;
      case 'battery':
        this.click(this.place(x, y, l, 0.5), 0, 1800);
        this.blip(this.place(x, y, l, 0.25), [880]);
        break;
      case 'horde':
        this.horde();
        break;
      case 'helicopter':
        this.rotor(this.place(x, y, l, 1, 90));
        break;
      case 'throw':
        this.swing(this.place(x, y, l, 0.6));
        break;
      case 'bounce':
        if (this.throttle('bounce', 0.08)) this.click(this.place(x, y, l, 0.7), 0, 900);
        break;
      case 'scream':
        this.scream(this.place(x, y, l, 1, 70));
        break;
      case 'weapon':
        this.click(this.place(x, y, l, 0.6), 0, 1400);
        this.click(this.place(x, y, l, 0.6), 0.12, 2400);
        this.blip(this.place(x, y, l, 0.3), [440, 660, 880]);
        break;
      case 'switch':
        this.click(this.place(x, y, l, 0.4), 0, 1700);
        break;
      case 'roar':
        // Se oye desde lejos y fuerte: es el aviso de que viene una roca o una embestida.
        if (this.throttle('roar', 0.6)) this.roar(this.place(x, y, l, 1.3, 90));
        break;
      case 'pack':
        // Varios gruñidos encimados, desfasados: suena a manada, no a un zombie.
        for (let i = 0; i < 4; i++) {
          const delay = i * (90 + Math.random() * 120);
          setTimeout(() => this.groan(this.place(x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 6, l, 0.8, 40), true), delay);
        }
        break;
      case 'dash':
        this.whoosh(this.place(x, y, l, 0.7));
        break;
      case 'tired':
        if (this.throttle('tired', 0.8)) this.breath(this.place(x, y, l, 0.5));
        break;
      case 'break': {
        // El arma blanca se parte: un crujido de madera/metal.
        const out = this.place(x, y, l, 0.9);
        if (out) {
          this.burst(out, 0, 0.18, 'bandpass', 1400, 1, 3);
          this.click(out, 0.02, 700);
          this.click(out, 0.07, 450);
        }
        break;
      }
      case 'sever':
        if (this.throttle('sever', 0.06)) this.crunch(this.place(x, y, l, 1));
        break;
      case 'ignite': {
        if (!this.throttle('ignite', 0.25)) break;
        const out = this.place(x, y, l, 0.7);
        if (out) {
          const f = this.burst(out, 0, 0.6, 'bandpass', 600, 0.9, 0.8);
          f.frequency.exponentialRampToValueAtTime(2200, this.ctx!.currentTime + 0.5);
        }
        break;
      }
      case 'glass': {
        const out = this.place(x, y, l, 1);
        if (out) {
          this.burst(out, 0, 0.25, 'highpass', 4500, 0.9);
          for (let i = 0; i < 4; i++) this.tone(out, i * 0.03, 'triangle', 3000 + i * 700, 2500 + i * 500, 0.12, 0.15);
        }
        break;
      }
      case 'firecracker': {
        // Una ristra: estallidos chicos y desparejos, que se oyen desde lejos.
        const out = this.place(x, y, l, 0.9, 70);
        if (out) {
          for (let i = 0; i < 4; i++) {
            const at = i * 0.07 + Math.random() * 0.05;
            this.burst(out, at, 0.06, 'highpass', 1500, 0.9);
            this.tone(out, at, 'sine', 300, 80, 0.05, 0.4);
          }
        }
        break;
      }
      case 'radio': {
        // Música de radio "de lata": unas notas cuadradas detrás de estática.
        const out = this.place(x, y, l, 0.5, 50);
        if (out) {
          this.burst(out, 0, 1.1, 'bandpass', 2500, 0.15, 0.7);
          const notes = [523, 659, 784, 659];
          notes.forEach((n, i) => this.tone(out, i * 0.27, 'square', n, n, 0.24, 0.09));
        }
        break;
      }
      case 'spit': {
        const out = this.place(x, y, l, 0.8);
        if (out) {
          this.burst(out, 0, 0.2, 'bandpass', 900, 1, 2);
          this.tone(out, 0, 'sawtooth', 220, 90, 0.18, 0.2);
        }
        break;
      }
      case 'plane': {
        // Un avión que pasa alto: zumbido grave que sube y baja (efecto Doppler a mano).
        const out = this.place(l.x, l.y, l, 0.7, 1000);
        if (out) {
          const ctx = this.ctx!;
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          const t = ctx.currentTime;
          osc.frequency.setValueAtTime(70, t);
          osc.frequency.linearRampToValueAtTime(95, t + 3);
          osc.frequency.linearRampToValueAtTime(55, t + 7);
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = 400;
          const env = ctx.createGain();
          env.gain.setValueAtTime(0.0001, t);
          env.gain.exponentialRampToValueAtTime(0.35, t + 3);
          env.gain.exponentialRampToValueAtTime(0.0001, t + 7);
          osc.connect(lp).connect(env).connect(out);
          osc.start(t);
          osc.stop(t + 7.1);
          this.burst(out, 0, 7, 'lowpass', 300, 0.25);
        }
        break;
      }
      case 'landing': {
        const out = this.place(x, y, l, 1, 80);
        if (out) {
          this.tone(out, 0, 'sine', 80, 35, 0.4, 1);
          this.burst(out, 0, 0.3, 'lowpass', 1200, 0.8);
          this.click(out, 0.05, 600);
        }
        break;
      }
      case 'rocket': {
        const out = this.place(x, y, l, 1);
        if (out) {
          this.tone(out, 0, 'sine', 120, 50, 0.2, 0.9);
          const f = this.burst(out, 0, 0.9, 'bandpass', 500, 0.9, 0.7);
          f.frequency.exponentialRampToValueAtTime(3000, this.ctx!.currentTime + 0.8);
        }
        break;
      }
    }
  }

  // --- Bloques de construcción ---------------------------------------------------------------

  /** Ruido blanco filtrado con una envolvente de ataque y caída. */
  private burst(
    out: AudioNode,
    at: number,
    duration: number,
    filter: BiquadFilterType,
    freq: number,
    peak: number,
    q = 1,
  ): BiquadFilterNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true; // el buffer dura 1 s; las explosiones y la horda duran más
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const env = ctx.createGain();
    const t = ctx.currentTime + at;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(f).connect(env).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + duration + 0.05);
    return f;
  }

  /** Tono con barrido de frecuencia y caída exponencial. */
  private tone(out: AudioNode, at: number, type: OscillatorType, from: number, to: number, duration: number, peak: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    const t = ctx.currentTime + at;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  // --- Sonidos -------------------------------------------------------------------------------

  private shot(out: AudioNode | null): void {
    if (!out) return;
    this.burst(out, 0, 0.22, 'lowpass', 3500, 1.0);
    this.burst(out, 0, 0.06, 'highpass', 2500, 0.6);
    this.tone(out, 0, 'sine', 150, 40, 0.18, 0.9);
    // Eco de la calle: el mismo estallido, más bajo y apagado, un poco después.
    this.burst(out, 0.09, 0.45, 'lowpass', 900, 0.25);
  }

  /** Escopeta: más grave y más larga que la pistola, con un eco más fuerte. */
  private shotgun(out: AudioNode | null): void {
    if (!out) return;
    this.burst(out, 0, 0.35, 'lowpass', 2200, 1.2);
    this.burst(out, 0, 0.08, 'highpass', 1800, 0.7);
    this.tone(out, 0, 'sine', 110, 32, 0.3, 1.1);
    this.burst(out, 0.12, 0.7, 'lowpass', 700, 0.35);
    // El "chak-chak" de la corredera, un poco después.
    this.click(out, 0.42, 1300);
    this.click(out, 0.55, 1900);
  }

  /** Subfusil: un estallido corto y seco (suena 13 veces por segundo, no puede tener cola larga). */
  private smg(out: AudioNode | null): void {
    if (!out) return;
    this.burst(out, 0, 0.09, 'lowpass', 4200, 0.8);
    this.burst(out, 0, 0.03, 'highpass', 3000, 0.5);
    this.tone(out, 0, 'sine', 180, 60, 0.07, 0.6);
  }

  /**
   * Explosión: un golpe sub-grave que se siente (senoidal de 90 a 25 Hz), el estruendo de ruido
   * filtrado que se va cerrando (cada vez más apagado: así suena algo grande y lejano) y el
   * retumbar de los edificios.
   */
  private explosion(out: AudioNode | null, small: boolean): void {
    if (!out) return;
    const size = small ? 0.5 : 1;
    this.tone(out, 0, 'sine', 90, 25, 0.9 * size, 1.4 * size);
    const roar = this.burst(out, 0, 1.4 * size, 'lowpass', 3000, 1.3 * size);
    roar.frequency.exponentialRampToValueAtTime(250, this.ctx!.currentTime + 1.2 * size);
    this.burst(out, 0, 0.12, 'highpass', 2000, 0.8 * size);
    if (!small) this.burst(out, 0.25, 2.2, 'lowpass', 180, 0.5);
  }

  /** El hinchado revienta: un "plaf" húmedo y grave. */
  private splat(out: AudioNode | null): void {
    if (!out) return;
    this.tone(out, 0, 'sine', 70, 30, 0.35, 1);
    this.burst(out, 0, 0.3, 'bandpass', 500, 1, 1.5);
    this.burst(out, 0.05, 0.4, 'lowpass', 900, 0.5);
  }

  /** Grito del gritón: dos chillidos agudos y desafinados que suben y bajan. */
  private scream(out: AudioNode | null): void {
    if (!out) return;
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'bandpass';
    lp.frequency.value = 1400;
    lp.Q.value = 1.2;
    lp.connect(out);
    this.tone(lp, 0, 'sawtooth', 520, 900, 0.5, 0.7);
    this.tone(lp, 0.02, 'sawtooth', 560, 960, 0.55, 0.5);
    this.tone(lp, 0.5, 'sawtooth', 950, 420, 0.9, 0.7);
    this.burst(out, 0, 1.3, 'bandpass', 2500, 0.3, 2);
  }

  private swing(out: AudioNode | null): void {
    if (!out) return;
    const f = this.burst(out, 0, 0.18, 'bandpass', 600, 0.5, 2);
    f.frequency.exponentialRampToValueAtTime(2400, this.ctx!.currentTime + 0.15);
  }

  private hit(out: AudioNode | null): void {
    if (!out) return;
    this.tone(out, 0, 'sine', 110, 50, 0.12, 0.8);
    this.burst(out, 0, 0.09, 'lowpass', 1200, 0.5);
  }

  private crunch(out: AudioNode | null): void {
    if (!out) return;
    this.burst(out, 0.02, 0.12, 'bandpass', 1800, 0.6, 3);
    this.burst(out, 0.07, 0.1, 'bandpass', 1200, 0.4, 3);
  }

  private hurt(out: AudioNode | null): void {
    if (!out) return;
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.connect(out);
    this.tone(lp, 0, 'sawtooth', 190, 110, 0.22, 0.5);
    this.burst(out, 0, 0.08, 'lowpass', 600, 0.6);
  }

  private step(out: AudioNode | null): void {
    if (!out) return;
    this.burst(out, 0, 0.07, 'lowpass', 420 + Math.random() * 200, 0.8);
  }

  private click(out: AudioNode | null, at: number, freq: number): void {
    if (!out) return;
    this.burst(out, at, 0.035, 'bandpass', freq, 0.9, 4);
  }

  private blip(out: AudioNode | null, notes: number[]): void {
    if (!out) return;
    notes.forEach((n, i) => this.tone(out, i * 0.07, 'triangle', n, n, 0.12, 0.6));
  }

  /**
   * Rugido del tanque: dos dientes de sierra muy graves y desafinados entre sí (eso da el "batido"
   * áspero), que suben y bajan, más un ruido rasposo encima. Dura más de un segundo.
   */
  private roar(out: AudioNode | null): void {
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const duration = 1.2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.linearRampToValueAtTime(1100, t + 0.35);
    lp.frequency.linearRampToValueAtTime(400, t + duration);
    lp.Q.value = 3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.9, t + 0.15);
    env.gain.setValueAtTime(0.9, t + 0.7);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    lp.connect(env).connect(out);
    for (const base of [52, 57]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.linearRampToValueAtTime(base * 1.5, t + 0.35);
      osc.frequency.linearRampToValueAtTime(base * 0.8, t + duration);
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    }
    this.burst(out, 0.05, duration, 'bandpass', 380, 0.35, 2);
  }

  /** Dash: un soplido corto de ruido agudo que baja. */
  private whoosh(out: AudioNode | null): void {
    if (!out) return;
    const f = this.burst(out, 0, 0.22, 'bandpass', 2400, 0.5, 1.5);
    f.frequency.exponentialRampToValueAtTime(700, this.ctx!.currentTime + 0.22);
  }

  /** Sin aire: una exhalación grave y apagada. */
  private breath(out: AudioNode | null): void {
    if (!out) return;
    this.burst(out, 0, 0.45, 'bandpass', 650, 0.35, 0.8);
  }

  /** Gruñido: diente de sierra grave con vibrato, filtrado. "angry" = más fuerte y más agudo. */
  private groan(out: AudioNode | null, angry = false): void {
    if (!out) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const duration = angry ? 0.7 : 0.9 + Math.random() * 0.6;
    const base = (angry ? 120 : 70) + Math.random() * 40;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.linearRampToValueAtTime(base * (angry ? 0.7 : 0.85), t + duration);
    // Vibrato: otro oscilador lento que mueve la frecuencia del primero.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5 + Math.random() * 4;
    const depth = ctx.createGain();
    depth.gain.value = base * 0.08;
    lfo.connect(depth).connect(osc.frequency);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = angry ? 900 : 520;
    lp.Q.value = 4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(angry ? 0.55 : 0.35, t + 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(lp).connect(env).connect(out);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + duration + 0.05);
    lfo.stop(t + duration + 0.05);
  }

  /** Muchos gruñidos desafinados que crecen: la horda que viene. */
  private horde(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.5, t + 1.5);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    out.connect(lp).connect(this.master!);
    for (let i = 0; i < 7; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 55 + Math.random() * 50;
      osc.connect(out);
      osc.start(t + Math.random() * 0.6);
      osc.stop(t + 4.1);
    }
    this.burst(out, 0, 4, 'lowpass', 300, 0.5);
  }

  /** Aspas del helicóptero: ruido grave pulsado ~11 veces por segundo durante unos segundos. */
  private rotor(out: AudioNode | null): void {
    if (!out) return;
    for (let i = 0; i < 70; i++) this.burst(out, i / 11, 0.07, 'lowpass', 260, 0.8 * Math.min(1, (70 - i) / 20));
  }

  private alarm(out: AudioNode | null): void {
    if (!out) return;
    for (let i = 0; i < 12; i++) this.tone(out, i * 0.32, 'square', i % 2 ? 620 : 820, i % 2 ? 620 : 820, 0.3, 0.25);
  }

  /** Minigun: un golpe corto y grave; a 22 por segundo suena a motosierra de balas. */
  private minigun(out: AudioNode | null): void {
    if (!out) return;
    this.burst(out, 0, 0.05, 'lowpass', 2600, 0.7);
    this.tone(out, 0, 'sine', 140, 60, 0.05, 0.5);
  }

  /** Lanzallamas: un soplido continuo (se encadenan varios). */
  private flame(out: AudioNode | null): void {
    if (!out) return;
    this.burst(out, 0, 0.16, 'bandpass', 700, 0.45, 0.6);
    this.burst(out, 0, 0.12, 'lowpass', 250, 0.4);
  }

  private heartbeat(): void {
    const out = this.master!;
    this.tone(out, 0, 'sine', 60, 40, 0.14, 0.55);
    this.tone(out, 0.18, 'sine', 55, 38, 0.16, 0.4);
  }
}
