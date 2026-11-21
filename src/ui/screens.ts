// Pantallas encima del juego: inicio (controles), pausa, victoria y derrota.
// Mientras una pantalla está abierta la simulación no avanza.

export type ScreenKind = 'intro' | 'pause' | 'won' | 'lost' | null;

export interface RunSummary {
  seed: string;
  time: string;
  clock: string;
  kills: number;
  shots: number;
  via?: string;
}

const CONTROLS = `
  <div class="controls">
    <div><b>WASD</b> moverse</div><div><b>Mouse</b> apuntar</div>
    <div><b>Clic</b> atacar</div><div><b>Clic der.</b> golpe rápido</div><div><b>Espacio</b> dash (gasta estamina)</div>
    <div><b>Q</b> siguiente arma · <b>1-4</b> bate, pistola, escopeta, subfusil</div><div><b>R</b> recargar</div>
    <div><b>G</b> lanzar granada (hacia el mouse)</div><div><b>Barriles rojos</b>: dispárales</div>
    <div><b>F</b> linterna</div><div><b>B</b> cambiar batería</div>
    <div><b>H</b> botiquín</div><div><b>E</b> (mantener) revisar autos, cajas y cuerpos</div>
    <div><b>Shift</b> (mantener) sigilo: lento y silencioso</div><div><b>Rueda</b> acercar / alejar</div>
    <div><b>M</b> mapa</div><div><b>Esc</b> pausa · <b>O</b> sonido</div>
  </div>`;

export class Screens {
  private readonly root: HTMLElement;
  current: ScreenKind = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'screen';
    document.body.appendChild(this.root);
    this.show(null);
  }

  show(kind: ScreenKind, summary?: RunSummary): void {
    this.current = kind;
    this.root.style.display = kind ? '' : 'none';
    if (!kind) return;
    this.root.className = kind;
    const seedLine = summary ? `<div class="seed">seed <b>${escapeHtml(summary.seed)}</b></div>` : '';
    switch (kind) {
      case 'intro':
        this.root.innerHTML = `
          <h1>ZOMBIE CITY</h1>
          <p class="lead">Son las 02:00. La ciudad cayó. Llega a una salida antes de que se vaya.<br>
          Las salidas cercanas se van antes; la más lejana espera siempre. Mira el reloj y el mapa.</p>
          ${seedLine}${CONTROLS}
          <p class="action">Clic o <b>Enter</b> para empezar</p>`;
        break;
      case 'pause':
        this.root.innerHTML = `<h1>PAUSA</h1>${seedLine}${CONTROLS}
          <p class="action"><b>Esc</b> o clic para seguir · <b>N</b> nueva ciudad</p>`;
        break;
      case 'won':
      case 'lost': {
        const s = summary!;
        this.root.innerHTML = `
          <h1>${kind === 'won' ? 'ESCAPASTE' : 'TE ALCANZARON'}</h1>
          <p class="lead">${kind === 'won' ? `Saliste en ${s.via} a las ${s.clock}.` : `Caíste a las ${s.clock}.`}</p>
          <div class="stats">
            <div><span>tiempo</span><b>${s.time}</b></div>
            <div><span>zombies</span><b>${s.kills}</b></div>
            <div><span>disparos</span><b>${s.shots}</b></div>
          </div>
          ${seedLine}
          <p class="action"><b>Enter</b> repetir esta ciudad · <b>N</b> ciudad nueva</p>`;
        break;
      }
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
