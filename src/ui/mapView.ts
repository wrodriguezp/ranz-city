// Minimapa (esquina) y mapa completo (tecla M).
//
// El mapa solo muestra lo que ya VISTE: niebla de guerra. Cada 0.25 s lanzamos ~120 rayos en
// círculo desde el jugador (el mismo DDA de la linterna y las balas, ver visibility.ts) y
// marcamos los tiles que tocan como descubiertos. Las salidas se ven siempre: las conoces por
// la radio de evacuación.
//
// Truco de dibujo: la grilla descubierta se pinta en un canvas chico de 1 píxel por tile
// (132 × 132). Ese canvas se dibuja agrandado y rotado en el minimapa: la GPU del navegador
// hace el escalado y no hay que redibujar miles de rectángulos por cuadro.
//
// Rotación: la cámara isométrica mira en diagonal, así que "arriba en la pantalla" es la
// dirección (-1, -1) del mundo. Girando el mapa +45° (ctx.rotate(π/4)) el mapa queda
// orientado igual que lo que ves en pantalla.

import type { GameState } from '../game/state';
import { blocksSight, traceRay } from '../game/visibility';
import type { City } from '../world/city';
import { Tile } from '../world/tileGrid';
import { exitPosition } from '../world/zones';

const RAYS = 120;
const RAY_LENGTH = 18;
const REVEAL_INTERVAL = 0.25;
const MINI_SIZE = 190;
const MINI_SCALE = 3.2;

const TILE_COLORS: Record<number, [number, number, number]> = {
  [Tile.Street]: [52, 56, 62],
  [Tile.Sidewalk]: [92, 97, 104],
  [Tile.Building]: [24, 26, 30],
  [Tile.Barricade]: [217, 130, 43],
  [Tile.Plaza]: [74, 92, 64],
  [Tile.Car]: [120, 70, 70],
  [Tile.Crate]: [150, 115, 60],
};

export interface ExitMarker {
  label: string;
  /** Texto extra (p. ej. la hora límite). */
  detail?: string;
  /** Salidas que ya no sirven se dibujan en gris. */
  closed?: boolean;
}

export class MapView {
  private readonly discovered: Uint8Array;
  private readonly fog: HTMLCanvasElement;
  private readonly fogCtx: CanvasRenderingContext2D;
  private readonly fogImage: ImageData;
  private readonly mini: HTMLCanvasElement;
  private readonly full: HTMLCanvasElement;
  private readonly fullWrap: HTMLElement;
  private revealTimer = 0;
  private dirty = true;
  open = false;

  constructor(private city: City) {
    const { width, height } = city.grid;
    this.discovered = new Uint8Array(width * height);
    this.fog = document.createElement('canvas');
    this.fog.width = width;
    this.fog.height = height;
    this.fogCtx = this.fog.getContext('2d')!;
    this.fogImage = this.fogCtx.createImageData(width, height);

    this.mini = document.createElement('canvas');
    this.mini.id = 'minimap';
    this.mini.width = MINI_SIZE * devicePixelRatio;
    this.mini.height = MINI_SIZE * devicePixelRatio;
    this.mini.style.width = `${MINI_SIZE}px`;
    this.mini.style.height = `${MINI_SIZE}px`;
    document.body.appendChild(this.mini);

    this.fullWrap = document.createElement('div');
    this.fullWrap.id = 'fullmap';
    this.fullWrap.innerHTML = '<div class="title">MAPA · <span class="dim">[M] cerrar</span></div>';
    this.full = document.createElement('canvas');
    this.fullWrap.appendChild(this.full);
    document.body.appendChild(this.fullWrap);
    this.setOpen(false);
  }

  /** Nueva ciudad: se olvida todo lo descubierto. */
  reset(city: City): void {
    this.city = city;
    this.discovered.fill(0);
    this.fogImage.data.fill(0);
    this.revealTimer = 0;
    this.dirty = true;
  }

  setVisible(visible: boolean): void {
    this.mini.style.display = visible ? '' : 'none';
    if (!visible) this.setOpen(false);
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.fullWrap.style.display = open ? '' : 'none';
  }

  update(state: GameState, dt: number, exits: ExitMarker[]): void {
    this.revealTimer -= dt;
    if (this.revealTimer <= 0) {
      this.revealTimer = REVEAL_INTERVAL;
      this.reveal(state.player.x, state.player.y);
    }
    if (this.dirty) {
      this.fogCtx.putImageData(this.fogImage, 0, 0);
      this.dirty = false;
    }
    this.drawMini(state, exits);
    if (this.open) this.drawFull(state, exits);
  }

  private reveal(px: number, py: number): void {
    const { grid } = this.city;
    const mark = (tx: number, ty: number) => {
      if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return;
      const i = ty * grid.width + tx;
      if (this.discovered[i]) return;
      this.discovered[i] = 1;
      const [r, g, b] = TILE_COLORS[grid.tiles[i]] ?? [60, 60, 60];
      this.fogImage.data.set([r, g, b, 255], i * 4);
      this.dirty = true;
    };
    // Alrededor inmediato, siempre (lo "sientes" aunque no lo veas).
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(Math.floor(px) + dx, Math.floor(py) + dy);
    for (let i = 0; i < RAYS; i++) {
      const angle = (i / RAYS) * Math.PI * 2;
      traceRay(grid, px, py, Math.cos(angle), Math.sin(angle), RAY_LENGTH, (tx, ty, tile) => {
        mark(tx, ty);
        return blocksSight(tile); // la pared se marca y el rayo se detiene
      });
    }
  }

  private drawMini(state: GameState, exits: ExitMarker[]): void {
    const ctx = this.mini.getContext('2d')!;
    const size = this.mini.width;
    const scale = MINI_SCALE * devicePixelRatio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fill();
    ctx.clip();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(Math.PI / 4);
    ctx.scale(scale, scale);
    ctx.translate(-state.player.x, -state.player.y);
    this.drawWorld(ctx, state, exits, scale, size / 2 / scale - 2);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawFull(state: GameState, exits: ExitMarker[]): void {
    const { grid } = this.city;
    const cssSize = Math.min(innerWidth, innerHeight) * 0.82;
    const px = Math.round(cssSize * devicePixelRatio);
    if (this.full.width !== px) {
      this.full.width = px;
      this.full.height = px;
      this.full.style.width = `${cssSize}px`;
      this.full.style.height = `${cssSize}px`;
    }
    const ctx = this.full.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    // La diagonal de la ciudad (rotada 45°) tiene que caber en el canvas.
    const scale = px / (grid.width * Math.SQRT2 * 1.02);
    ctx.translate(px / 2, px / 2);
    ctx.rotate(Math.PI / 4);
    ctx.scale(scale, scale);
    ctx.translate(-grid.width / 2, -grid.height / 2);
    ctx.fillStyle = 'rgba(8,9,12,0.92)';
    ctx.fillRect(0, 0, grid.width, grid.height);
    this.drawWorld(ctx, state, exits, scale, Infinity);
  }

  /** Dibuja en coordenadas de tiles (la transformación ya está puesta). */
  private drawWorld(ctx: CanvasRenderingContext2D, state: GameState, exits: ExitMarker[], scale: number, edgeRadius: number): void {
    const { city } = this;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.fog, 0, 0);
    const px = 1 / scale; // un píxel de pantalla, en tiles

    // Loot sin revisar ya descubierto: puntitos amarillos.
    ctx.fillStyle = '#ffd25a';
    for (const c of city.props) {
      if (state.loot.searched[c.id]) continue;
      const cx = Math.floor(c.x + c.w / 2);
      const cy = Math.floor(c.y + c.h / 2);
      if (!this.discovered[cy * city.grid.width + cx]) continue;
      ctx.fillRect(c.x + c.w / 2 - 2 * px, c.y + c.h / 2 - 2 * px, 4 * px, 4 * px);
    }

    // Salidas: siempre visibles. En el minimapa, si quedan fuera del círculo se pegan al borde.
    const { x: pX, y: pY } = state.player;
    city.layout.exits.forEach((exit, i) => {
      const pos = exitPosition(city.layout.graph, exit);
      let ex = pos.x;
      let ey = pos.y;
      const d = Math.hypot(ex - pX, ey - pY);
      if (d > edgeRadius) {
        ex = pX + ((ex - pX) / d) * edgeRadius;
        ey = pY + ((ey - pY) / d) * edgeRadius;
      }
      const marker = exits[i];
      ctx.fillStyle = marker?.closed ? '#777' : exit.kind === 'helicopter' ? '#ffcf4d' : '#ff5a4d';
      ctx.beginPath();
      ctx.arc(ex, ey, 6 * px, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5 * px;
      ctx.stroke();
      // Los rótulos solo en el mapa grande: en el minimapa se amontonan en el borde.
      if (marker && edgeRadius === Infinity) this.label(ctx, ex, ey + 10 * px, px, marker.detail ? `${marker.label} · ${marker.detail}` : marker.label, !!marker.closed);
    });

    // Jugador: flecha en la dirección en la que mira.
    ctx.save();
    ctx.translate(pX, pY);
    ctx.rotate(state.player.facing);
    ctx.fillStyle = '#5fd0ff';
    ctx.beginPath();
    ctx.moveTo(8 * px, 0);
    ctx.lineTo(-5 * px, 5 * px);
    ctx.lineTo(-2 * px, 0);
    ctx.lineTo(-5 * px, -5 * px);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Texto horizontal en pantalla aunque el mapa esté rotado. */
  private label(ctx: CanvasRenderingContext2D, x: number, y: number, px: number, text: string, dim: boolean): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 4);
    ctx.scale(px, px);
    ctx.font = `bold ${11 * devicePixelRatio}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = dim ? '#999' : '#fff';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}
