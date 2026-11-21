// Clima de la noche, elegido por la seed (es parte del mundo estático: misma seed, mismo clima).
//
// No es solo decorado; cambia cómo se juega:
//  - Lluvia: tapa los ruidos (los zombies oyen menos) y ven un poco peor. Buena noche para el sigilo.
//  - Niebla: los zombies ven mucho menos... pero tú también (la niebla tapa la pantalla a lo lejos).
//    Te topas con ellos de cerca: más estrés, pilar 1 del diseño.

import type { Rng } from './rng';

export type Weather = 'clear' | 'rain' | 'fog';

export interface WeatherEffects {
  /** Multiplica el alcance de la vista de los zombies. */
  sight: number;
  /** Multiplica el radio en que los zombies oyen un ruido. */
  hearing: number;
  /** Cómo se lo contamos al jugador. */
  label: string;
}

export const WEATHER_EFFECTS: Record<Weather, WeatherEffects> = {
  clear: { sight: 1, hearing: 1, label: 'noche despejada' },
  rain: { sight: 0.85, hearing: 0.7, label: 'lluvia: los ruidos se oyen menos' },
  fog: { sight: 0.6, hearing: 1, label: 'niebla: nadie ve lejos' },
};

export function rollWeather(rng: Rng): Weather {
  const r = rng.float();
  if (r < 0.45) return 'clear';
  return r < 0.75 ? 'rain' : 'fog';
}
