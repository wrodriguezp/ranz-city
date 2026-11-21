// Linterna: encendido, batería y parpadeo. Pura lógica: el SpotLight que la dibuja vive en render/.
//
// Es la decisión central del pilar "estrés por no ver": con la linterna ves lejos, pero también
// te ven de más lejos (ver zombies.ts). Apagarla es esconderse; dejarla prendida gasta batería.

export interface FlashlightState {
  on: boolean;
  /** Carga de la batería puesta, de 0 a 100. */
  charge: number;
}

/** Segundos que dura una batería llena con la linterna encendida. */
export const BATTERY_SECONDS = 180;
/** Bajo esta carga la luz empieza a parpadear y a acortarse: aviso de que se acaba. */
export const LOW_BATTERY = 20;

export function createFlashlight(): FlashlightState {
  return { on: true, charge: 100 };
}

export function updateFlashlight(light: FlashlightState, dt: number): void {
  if (light.on && light.charge > 0) light.charge = Math.max(0, light.charge - (100 / BATTERY_SECONDS) * dt);
}

/**
 * Potencia efectiva de la luz, de 0 a 1, en el instante `time` (segundos de partida).
 * Con batería baja parpadea. El parpadeo sale de senos con frecuencias que no se repiten entre sí,
 * no de Math.random(): así es determinista (misma partida, mismo parpadeo) y no necesita estado.
 */
export function flashlightPower(light: FlashlightState, time: number): number {
  if (!light.on || light.charge <= 0) return 0;
  if (light.charge >= LOW_BATTERY) return 1;
  const level = light.charge / LOW_BATTERY; // 1 → recién entró en batería baja, 0 → vacía
  const wobble = Math.sin(time * 13.1) + Math.sin(time * 31.7) + Math.sin(time * 5.3);
  // Mientras menos carga, más seguido cae bajo el umbral y la luz "se corta".
  const cut = wobble < -2.2 + (1 - level) * 1.6 ? 0.08 : 1;
  return (0.45 + 0.55 * level) * cut;
}
