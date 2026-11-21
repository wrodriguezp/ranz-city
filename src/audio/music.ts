// Música por estados, con las pistas de src/music (las hace Wilbert con Gemini).
//
// Estados: explorar (calma), tensión (te persiguen), horda (muchos encima) y escape (esperando
// en la zona de evacuación). Cambiar de estado hace un CROSSFADE: la pista vieja baja mientras
// la nueva sube, para que nunca se corte en seco.
//
// Loops que no cierran: las pistas generadas no siempre empalman bien el final con el inicio.
// Dos trucos:
//  1. Se recortan los silencios del principio y del final (se buscan las primeras/últimas
//     muestras con volumen audible en el audio decodificado).
//  2. En vez de usar `loop = true`, cada vuelta es una copia nueva de la pista que arranca unos
//     segundos ANTES de que termine la anterior, y se cruzan (una baja, la otra sube). El corte
//     queda escondido debajo del crossfade.
//
// Histéresis: subir de intensidad es rápido (te persiguen → tensión en ~1 s), pero bajar exige
// varios segundos de calma, para que la música no salte cada vez que un zombie te pierde de vista.
// Si una pista no existe (no está el .mp3), ese estado usa la de explorar, y si no hay ninguna
// el juego sigue sin música.

export type MusicMood = 'explore' | 'tension' | 'horde' | 'escape';

const FILES: Record<MusicMood, string> = {
  explore: 'explorar',
  tension: 'tension',
  horde: 'horda',
  escape: 'escape',
};
/** Orden de intensidad: subir es inmediato, bajar espera CALM_DELAY. */
const LEVEL: Record<MusicMood, number> = { explore: 0, tension: 1, horde: 2, escape: 3 };
const UP_DELAY = 0.8;
const CALM_DELAY = 7;
const MOOD_FADE = 2.5;
const LOOP_FADE = 4;
const SILENCE = 0.02;

// Vite resuelve las pistas a URLs al compilar. Si falta un archivo, simplemente no aparece aquí.
const urls = import.meta.glob('../music/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

interface Track {
  buffer: AudioBuffer;
  /** Segundo donde empieza y termina el sonido de verdad (sin silencios). */
  start: number;
  end: number;
}

interface Playing {
  mood: MusicMood;
  /** Volumen de la pista entera (para el crossfade entre estados). */
  gain: GainNode;
  /** Cuándo (en tiempo del contexto) hay que lanzar la próxima vuelta. */
  nextLoopAt: number;
  sources: AudioBufferSourceNode[];
}

export class Music {
  private readonly tracks = new Map<MusicMood, Track>();
  private loading = false;
  private current: Playing | null = null;
  /** El estado que se pide y desde cuándo se pide (para la histéresis). */
  private wanted: MusicMood = 'explore';
  private wantedFor = 0;

  constructor(private readonly output: () => { ctx: AudioContext; out: GainNode } | null) {}

  /**
   * Llamar cada cuadro con el estado que corresponde al juego. dt en segundos reales.
   */
  update(mood: MusicMood, dt: number): void {
    const audio = this.output();
    if (!audio || audio.ctx.state !== 'running') return;
    if (!this.loading) {
      this.loading = true;
      void this.load(audio.ctx);
    }
    if (mood !== this.wanted) {
      this.wanted = mood;
      this.wantedFor = 0;
    } else this.wantedFor += dt;

    const target = this.resolve(this.wanted);
    if (!target) return;
    const playing = this.current?.mood;
    if (playing !== target) {
      const up = !playing || LEVEL[target] > LEVEL[playing];
      if (!playing || this.wantedFor >= (up ? UP_DELAY : CALM_DELAY)) this.switchTo(target, audio.ctx, audio.out);
    }
    this.keepLooping(audio.ctx);
  }

  /** Para el HUD de depuración: qué suena (o por qué no suena nada). */
  get status(): string {
    if (this.current) return this.current.mood;
    return this.loading ? (this.tracks.size ? 'lista' : 'cargando') : 'sin audio (haz clic)';
  }

  /** Corta todo (al empezar una partida nueva, la música vuelve a explorar). */
  reset(): void {
    const audio = this.output();
    if (this.current && audio) this.fadeOut(this.current, audio.ctx, 0.8);
    this.current = null;
    this.wanted = 'explore';
    this.wantedFor = 0;
  }

  /** Si falta la pista de un estado, se usa una de menos intensidad. */
  private resolve(mood: MusicMood): MusicMood | null {
    const order: MusicMood[] = ['escape', 'horde', 'tension', 'explore'];
    for (const m of order.slice(order.indexOf(mood))) if (this.tracks.has(m)) return m;
    return null;
  }

  private async load(ctx: AudioContext): Promise<void> {
    // Primero la de explorar (es la que suena al empezar), después las demás.
    const moods = (Object.keys(FILES) as MusicMood[]).sort((a, b) => LEVEL[a] - LEVEL[b]);
    for (const mood of moods) {
      const url = Object.entries(urls).find(([path]) => path.endsWith(`/${FILES[mood]}.mp3`))?.[1];
      if (!url) continue;
      try {
        const data = await (await fetch(url)).arrayBuffer();
        const buffer = await ctx.decodeAudioData(data);
        this.tracks.set(mood, { buffer, ...trimSilence(buffer) });
      } catch (err) {
        console.warn(`No se pudo cargar la música "${FILES[mood]}"`, err);
      }
    }
  }

  private switchTo(mood: MusicMood, ctx: AudioContext, out: GainNode): void {
    if (this.current) this.fadeOut(this.current, ctx, MOOD_FADE);
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(1, now + MOOD_FADE);
    gain.connect(out);
    this.current = { mood, gain, nextLoopAt: now, sources: [] };
    this.keepLooping(ctx);
  }

  /** Lanza la siguiente vuelta un poco antes de que termine la actual (crossfade del loop). */
  private keepLooping(ctx: AudioContext): void {
    const p = this.current;
    if (!p) return;
    const track = this.tracks.get(p.mood)!;
    // Programar con medio segundo de anticipación: el reloj del audio es exacto, el de los cuadros no.
    while (ctx.currentTime + 0.5 >= p.nextLoopAt) {
      const at = Math.max(p.nextLoopAt, ctx.currentTime);
      const length = track.end - track.start;
      const fade = Math.min(LOOP_FADE, length / 4);
      const src = ctx.createBufferSource();
      src.buffer = track.buffer;
      const env = ctx.createGain();
      // La primera vuelta entra directa (ya hay fade del cambio de estado); las demás, con crossfade.
      const first = p.sources.length === 0;
      env.gain.setValueAtTime(first ? 1 : 0.0001, at);
      if (!first) env.gain.linearRampToValueAtTime(1, at + fade);
      env.gain.setValueAtTime(1, at + length - fade);
      env.gain.linearRampToValueAtTime(0.0001, at + length);
      src.connect(env).connect(p.gain);
      src.start(at, track.start, length);
      src.onended = () => {
        const i = p.sources.indexOf(src);
        if (i >= 0) p.sources.splice(i, 1);
      };
      p.sources.push(src);
      p.nextLoopAt = at + length - fade;
    }
  }

  private fadeOut(p: Playing, ctx: AudioContext, seconds: number): void {
    const now = ctx.currentTime;
    p.gain.gain.cancelScheduledValues(now);
    p.gain.gain.setValueAtTime(Math.max(0.0001, p.gain.gain.value), now);
    p.gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    for (const src of p.sources) src.stop(now + seconds + 0.1);
    // Que no programe más vueltas.
    p.nextLoopAt = Infinity;
  }
}

/** Primer y último instante con sonido audible (amplitud > SILENCE en cualquier canal). */
function trimSilence(buffer: AudioBuffer): { start: number; end: number } {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const loud = (i: number) => channels.some((d) => Math.abs(d[i]) > SILENCE);
  let first = 0;
  while (first < buffer.length && !loud(first)) first++;
  let last = buffer.length - 1;
  while (last > first && !loud(last)) last--;
  if (last <= first) return { start: 0, end: buffer.duration };
  return { start: first / buffer.sampleRate, end: (last + 1) / buffer.sampleRate };
}
