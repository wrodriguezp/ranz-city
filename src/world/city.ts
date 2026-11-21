// Punto de entrada de la generación del mundo estático.
//
// generateCity(seed) es una función pura: misma seed => misma ciudad, siempre.
// Todo lo que vive aquí es estático. El estado dinámico (zombies, loot recogido)
// irá en otra estructura serializable, como pide el CLAUDE.md.

import { generateLayout, type CityLayout } from './cityLayout';
import { planEncounters, type EncounterPlan } from './encounters';
import { hashString, Rng } from './rng';
import { BLOCK_SIZE, blockStart, buildTileGrid, nodeCenter, type TileGrid } from './tileGrid';
import { planEvacuation, type EvacPoint } from './evacuation';
import { placeBarrels, placeProps, type Barrel, type Container } from './props';
import { placeStreetLights, type LightMap } from './streetLights';
import { placeDecor, type Decor } from './decor';
import { rollWeather, type Weather } from './weather';
import { computeZones, dangerAt, type ZoneMap } from './zones';

export interface City {
  /** La seed tal como la escribió el jugador (texto). */
  seedText: string;
  seed: number;
  layout: CityLayout;
  grid: TileGrid;
  /** Posición inicial del jugador, en tiles. */
  spawn: { x: number; y: number };
  /** Dónde empiezan los zombies (el plan; los zombies vivos son estado dinámico). */
  encounters: EncounterPlan;
  /** Peligro por zona (sube cerca de las salidas). */
  zones: ZoneMap;
  /** Autos, cajas y cuerpos con su loot. */
  props: Container[];
  barrels: Barrel[];
  /** Faroles y la luz que dan (el sigilo no sirve bajo un farol). */
  lights: LightMap;
  /** Zonas de evacuación con su hora límite. */
  evac: EvacPoint[];
  /** Flechas de supervivientes, autos en llamas y basura (solo se ven). */
  decor: Decor;
  /** Clima de la noche. */
  weather: Weather;
  /** Huella de la ciudad generada, para comprobar a simple vista que la generación es determinista. */
  fingerprint: string;
}

export const CITY_NODES_PER_SIDE = 9;
export const CITY_CUT_RATIO = 0.3;

export function generateCity(seedText: string): City {
  // Si la seed es un número, se usa tal cual; si es texto, se convierte con un hash.
  const seed = /^\d+$/.test(seedText) ? Number(seedText) >>> 0 : hashString(seedText);
  const rng = new Rng(seed);

  // Cada etapa usa su propio PRNG hijo (ver Rng.fork).
  const layout = generateLayout(rng.fork('layout'), {
    nodesPerSide: CITY_NODES_PER_SIDE,
    cutRatio: CITY_CUT_RATIO,
  });
  // Las zonas solo dependen del grafo: se calculan antes, así el tipo de cada manzana puede
  // depender del peligro (el retén militar va donde más peligro hay).
  const zones = computeZones(layout);
  const grid = buildTileGrid(layout, rng.fork('tiles'), (bx, by) =>
    dangerAt(zones, blockStart(bx) + BLOCK_SIZE / 2, blockStart(by) + BLOCK_SIZE / 2),
  );

  const { graph, startNode } = layout;
  const spawn = { x: nodeCenter(graph.nodeX(startNode)), y: nodeCenter(graph.nodeY(startNode)) };

  // Los props van antes que los zombies: estampan autos y cajas en la grilla, y así nadie
  // aparece adentro de un auto.
  const props = placeProps(grid, layout, zones, spawn, rng.fork('props'));
  const barrels = placeBarrels(grid, zones, spawn, rng.fork('barrels'));
  const encounters = planEncounters(grid, layout, zones, spawn, rng.fork('encounters'));

  const evac = planEvacuation(layout);
  const lights = placeStreetLights(grid, layout, rng.fork('lights'));
  // Va después de los props porque algunos autos se queman (y pierden su loot).
  const decor = placeDecor(grid, layout, props, spawn, rng.fork('decor'));
  const weather = rollWeather(rng.fork('weather'));

  return { seedText, seed, layout, grid, spawn, encounters, zones, props, barrels, lights, evac, decor, weather, fingerprint: fingerprintOf(grid) };
}

/** Hash FNV-1a de los tiles y las alturas de los edificios. */
function fingerprintOf(grid: TileGrid): string {
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  };
  for (const tile of grid.tiles) mix(tile);
  for (const b of grid.buildings) mix(b.floors);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
