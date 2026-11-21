// Escenario de la defensa final: lo que se construye en cada salida para el "aguanta X minutos".
//
// La idea viene del pilar de las hordas: durante la partida conviene esconderse, pero al final
// hay que PELEAR. Para que eso sea divertido y no un caos sin salida, cada salida es un embudo:
//  - Plaza del helicóptero: una valla militar rodea la manzana con UNA sola entrada. La valla
//    frena a los zombies pero se ve y se dispara a través (Tile.Fence), así que la horda se
//    amontona contra el alambre mientras la acribillas, y solo puede entrar por el hueco.
//  - Camión: queda al fondo de un callejón (cityLayout corta las otras calles de su cruce).
// Y en las dos hay un arsenal: una caja de munición que se RELLENA (se puede usar una y otra vez)
// y barriles explosivos en la boca del embudo.
//
// Todo esto es mundo estático: sale de la seed y se estampa en la grilla antes de ubicar a los
// zombies (así nadie aparece adentro de la valla).

import type { CityLayout } from './cityLayout';
import type { Barrel, Container } from './props';
import { BLOCK_SIZE, blockStart, nodeCenter, Tile, type TileGrid } from './tileGrid';

/** Ancho del hueco de la valla de la plaza (tiles). */
const GAP = 4;

export function placeFinales(grid: TileGrid, layout: CityLayout, props: Container[], barrels: Barrel[]): void {
  const { graph } = layout;
  const at = (x: number, y: number) => y * grid.width + x;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < grid.width && y < grid.height;
  const addCache = (x: number, y: number) => {
    grid.tiles[at(x, y)] = Tile.Crate;
    props.push({ id: props.length, kind: 'crate', x, y, w: 1, h: 1, angle: 0, alarm: false, variant: 1, loot: [], refill: true });
  };
  const addBarrel = (x: number, y: number) => {
    if (!inside(x, y) || grid.tiles[at(x, y)] !== Tile.Street) return;
    grid.tiles[at(x, y)] = Tile.Barrel;
    barrels.push({ id: barrels.length, x, y });
  };

  for (const exit of layout.exits) {
    const { dx, dy } = exit.funnel;
    if (exit.kind === 'helicopter') {
      const { bx, by } = exit.block!;
      const x0 = blockStart(bx);
      const y0 = blockStart(by);
      const last = BLOCK_SIZE - 1;
      // El hueco va centrado en el lado del embudo.
      const gapFrom = (BLOCK_SIZE - GAP) / 2;
      const inGap = (lx: number, ly: number) => {
        const along = dx !== 0 ? ly : lx;
        const onSide = dx === -1 ? lx === 0 : dx === 1 ? lx === last : dy === -1 ? ly === 0 : ly === last;
        return onSide && along >= gapFrom && along < gapFrom + GAP;
      };
      for (let ly = 0; ly <= last; ly++) {
        for (let lx = 0; lx <= last; lx++) {
          if (lx !== 0 && ly !== 0 && lx !== last && ly !== last) continue;
          if (inGap(lx, ly)) continue;
          // Solo sobre vereda: no pisamos cajas ni nada que ya esté.
          if (grid.tiles[at(x0 + lx, y0 + ly)] === Tile.Sidewalk) grid.tiles[at(x0 + lx, y0 + ly)] = Tile.Fence;
        }
      }
      // La caja de munición en la esquina libre del depósito (las otras tres son de props.ts).
      addCache(x0 + BLOCK_SIZE - 3, y0 + 2);
      // Dos barriles en la calle, frente a la entrada: la primera oleada que se amontone ahí...
      const cx = x0 + BLOCK_SIZE / 2 + dx * (BLOCK_SIZE / 2 + 3);
      const cy = y0 + BLOCK_SIZE / 2 + dy * (BLOCK_SIZE / 2 + 3);
      addBarrel(Math.floor(cx - dy * 3), Math.floor(cy - dx * 3));
      addBarrel(Math.floor(cx + dy * 3), Math.floor(cy + dx * 3));
    } else {
      const node = exit.node!;
      const cx = nodeCenter(graph.nodeX(node));
      const cy = nodeCenter(graph.nodeY(node));
      // En el cruce del camión, al fondo (del lado contrario a la calle abierta), a los costados.
      const px = -dy;
      const py = dx;
      const spots = [
        { x: Math.floor(cx - dx * 2.5 + px * 3), y: Math.floor(cy - dy * 2.5 + py * 3), cache: true },
        { x: Math.floor(cx - dx * 2.5 - px * 3), y: Math.floor(cy - dy * 2.5 - py * 3), cache: false },
      ];
      for (const s of spots) {
        if (!inside(s.x, s.y) || grid.tiles[at(s.x, s.y)] !== Tile.Street) continue;
        if (s.cache) {
          addCache(s.x, s.y);
        } else {
          grid.tiles[at(s.x, s.y)] = Tile.Crate;
          props.push({
            id: props.length,
            kind: 'crate',
            x: s.x,
            y: s.y,
            w: 1,
            h: 1,
            angle: 0,
            alarm: false,
            variant: 1,
            loot: [
              { type: 'ammo', amount: 40 },
              { type: 'shells', amount: 10 },
              { type: 'grenade', amount: 2 },
              { type: 'molotov', amount: 1 },
              { type: 'medkit', amount: 1 },
            ],
          });
        }
      }
      // Barriles en la calle de acceso, a media cuadra.
      const bx = cx + dx * 9;
      const by = cy + dy * 9;
      addBarrel(Math.floor(bx - px * 2), Math.floor(by - py * 2));
      addBarrel(Math.floor(bx + px * 2), Math.floor(by + py * 2));
    }
  }
}
