# RanZ City

**Random + Z.** Un shooter de zombies en 3D que corre en el navegador. Cada partida es una ciudad distinta,
generada a partir de una *seed*: de noche, con hordas, una linterna que apenas alcanza y un reloj que te
obliga a elegir entre una salida cercana y peligrosa que se va pronto, o una lejana que siempre espera.

**▶ Juégalo en [ranzcity.wrodriguez.dev](https://ranzcity.wrodriguez.dev)**

Para repetir una ciudad, agrega la seed a la URL: `https://ranzcity.wrodriguez.dev/?seed=tu-seed`.
La seed aparece al ganar, al perder y en la pausa.

> Prototipo v0: hecho en dos días (20 y 21 de noviembre de 2026) para responder una sola pregunta:
> *¿esto es divertido?* Lo diseñó y probó Wilbert Rodríguez, con [Claude Code](https://claude.com/claude-code)
> como programador.

## Qué tiene

- **Ciudad procedural y finita**: manzanas de varios tipos (parque, gasolinera, hospital, retén militar, canal
  con puentes…), calles cortadas con barricadas y clima por seed (despejado, lluvia o niebla).
- **Oscuridad**: la linterna con batería es casi la única luz y las paredes proyectan sombras reales. Bajo los
  faroles te ven de lejos; en lo oscuro puedes pasar en sigilo.
- **Hordas**: más de 100 zombies que te ven, te oyen, van al ruido, se avisan entre ellos y saltan vallas y autos.
- **Infectados especiales**: corredores, hinchados, gritones, escupidores, una sonámbula ciega y el tanque.
- **Rutas con riesgo y recompensa**: una ruta corta custodiada por el tanque y otras largas con más hordas.
- **Loot**: autos, cajas y cuerpos con munición, botiquines, baterías y armas.
- **Escape con reloj**: helicóptero o camiones; pides la evacuación por radio y defiendes la posición.
- **Sonido sintetizado** con Web Audio y música por capas que sube con la tensión.
- **Primera persona** experimental (tecla P).

Todo está hecho con formas básicas (cajas, cilindros y cápsulas): no hay modelos 3D ni texturas.

## Controles

| Tecla | Acción |
|---|---|
| WASD | Moverse |
| Mouse / clic | Apuntar / atacar (clic derecho: golpe rápido) |
| Espacio | Dash (gasta estamina) |
| Shift (mantener) | Sigilo: lento y silencioso |
| Q · 1-5 | Siguiente arma · elegir arma |
| R | Recargar |
| G · T | Lanzar (granada, molotov, petardos, radio, bengala) · elegir lanzable |
| F · B | Linterna · cambiar batería |
| H | Botiquín |
| E (mantener) | Revisar autos, cajas y cuerpos |
| M | Mapa |
| P | Primera persona |
| Rueda | Acercar / alejar |
| Esc · O | Pausa · sonido |

## Correrlo en local

Requiere Node 22 o superior.

```bash
npm install
npm run dev      # servidor de desarrollo
npm run build    # build estático en dist/
```

## Cómo está hecho

Vite + TypeScript + Three.js, sin backend.

- **El mundo es 2D por dentro y 3D solo al dibujarse.** La ciudad es una grilla de casillas; colisiones,
  visión, rutas y sonido se calculan en 2D, y Three.js solo levanta la geometría.
- **La ciudad es un grafo** de cruces y tramos. Cada calle cortada se verifica con BFS para que siempre
  exista un camino a las salidas.
- **Misma seed, misma ciudad**, gracias a un PRNG determinista (mulberry32).
- **Hordas con campos de flujo** y una grilla espacial para los vecinos: un solo cálculo para todos los zombies.
- **Instancing**: cada parte del cuerpo se dibuja de una vez para todos los zombies.
- **El estado dinámico vive aparte del mundo** y es serializable, pensando en un multijugador cooperativo futuro.

El detalle de cómo se trabajó está en [`docs/INFORME-V0.md`](docs/INFORME-V0.md) y el diseño original en
[`CLAUDE.md`](CLAUDE.md).
