# RanZ City: informe final del prototipo v0

Un shooter de zombies en 3D que corre en el navegador. Fue hecho en dos días (20 y 21 de noviembre de 2026) por
Wilbert Rodríguez trabajando con Claude Code (un agente de programación con IA) como programador. Este
documento cuenta qué se hizo, por qué y cómo. Durante el desarrollo se llamó *Zombie City*; al publicarlo pasó a
llamarse **RanZ City** (random + Z).

## En una frase
Una ciudad de noche, distinta en cada partida, con hordas de zombies, una linterna que apenas alcanza y un
reloj que te obliga a elegir: una salida cercana y peligrosa que se va pronto, o una lejana que siempre espera.

## La idea y de dónde viene
- **El ritmo de Left 4 Dead 2**: avanzar, aguantar hordas, infectados especiales (un tanque, un gritón, un
  escupidor) y una defensa final antes de escapar.
- **La exploración de Project Zomboid**: revisar autos, cajas y cuerpos buscando munición, botiquines y
  baterías.
- **Lo propio**: el mapa no es un pasillo. Es una ciudad laberinto generada a partir de un número (la
  *seed*), con calles cortadas, y el jugador elige su ruta según cuánto riesgo quiere correr.

El objetivo del prototipo nunca fue hacer el juego final, sino responder una pregunta: **¿esto es divertido?**
La respuesta fue sí.

## Los cinco pilares de diseño (en orden)
1. **Estrés por no ver**: noche, linterna con cono de luz y sombras reales que proyectan las paredes.
2. **Hordas**: muchos zombies a la vez (más de 100 en pantalla), que se sienta abrumador.
3. **Rutas con riesgo y recompensa**: una ruta corta custodiada por un tanque, otras largas con hordas.
4. **Escape con reloj**: cada salida tiene una hora límite; la más cercana se va primero y la más lejana
   espera siempre, así que nunca te quedas sin opción.
5. **Loot**: lo que encuentras decide si te alcanza para la ruta que elegiste.

## Qué tiene el juego terminado
- **Ciudad procedural finita**: manzanas de distintos tipos (parque, estacionamiento, gasolinera,
  construcción, barrio de casas, retén militar, hospital, canal con puentes), calles cortadas con
  barricadas, buses cruzados y escombros. Clima por seed: despejado, lluvia o niebla.
- **Oscuridad**: la linterna (con batería) es casi la única luz. Hay tramos con faroles: bajo la luz te
  ven de lejos y en lo oscuro puedes pasar en sigilo.
- **Zombies que piensan**: deambulan, te ven y te oyen. Van al ruido, se avisan entre ellos y se reparten
  roles (unos te persiguen, otros te cortan el paso por otra calle). Saltan vallas, barricadas y autos.
  Algunos esperan en los techos y saltan al verte.
- **Especiales**: corredores (algunos en llamas, inmunes al fuego), hinchados que explotan, gritones que
  llaman a la horda, escupidores de ácido, una sonámbula ciega que hay que pasar en silencio y el **tanque**:
  rápido, salta y aplasta un área, te lanza rocas, barriles y hasta otros zombies.
- **Armas**: bate, hacha, machete, mazo, katana, pistola con silenciador, escopeta, subfusil, granadas,
  molotovs, petardos, radio señuelo, bengalas y armas raras (minigun, lanzallamas, lanzacohetes).
  Desmembramiento: sin brazos el zombie no ataca y sin piernas se arrastra.
- **Escape**: helicóptero en una plaza o camiones en la carretera. Al llegar pides la evacuación por radio y
  defiendes la posición contra oleadas hasta que llega.
- **Sonido**: efectos y ambiente sintetizados en el navegador (pasos, gemidos, sirenas lejanas), un sonido
  propio para cada especial y música por capas que sube con la tensión. Wilbert generó la música con Gemini.
- **Personajes articulados** con piernas y brazos que caminan, y una **cámara en primera persona** experimental
  (tecla P), que terminó siendo la favorita de Wilbert: «se siente más inmersivo».

## Cómo se trabajó
- **Un brief primero.** Antes de escribir código, Wilbert escribió el documento de diseño (`CLAUDE.md`): la
  idea, los pilares, el alcance del v0 (solo exteriores, sin multijugador, sin modelos 3D, solo cajas,
  cilindros y cápsulas) y 8 hitos.
- **Un hito a la vez, cada uno jugable.** Ciudad → jugador → oscuridad → zombies → combate → rutas → loot →
  escape. Ningún hito avanzaba sin que el anterior se pudiera jugar. Después vinieron 7 rondas más (hitos 9 a
  15), cada una nacida de jugar y anotar lo que no funcionaba.
- **Ciclo de feedback real.** Wilbert jugaba, mandaba capturas y comentarios en lenguaje natural («el tanque se
  siente muy tonto, me queda mirando») y eso se convertía en un plan corto y en commits pequeños. Algunos
  ejemplos de feedback que cambiaron el juego:
  - «Cada disparo trae a toda la ciudad, no puedo usar las armas» → armas más silenciosas, un *director* que
    da respiros después de cada horda y una reserva finita de zombies.
  - «Escapar se siente vacío» → la defensa final con radio y oleadas por un embudo.
  - «Tengo monitor 2K y la información está lejísimos» → el HUD se movió junto a la mira.
  - «No me entero cuando me quedo sin balas» → recarga automática con sonido.
- **División de las pruebas.** La IA verificaba la lógica con simulaciones automáticas sin pantalla (por
  ejemplo, «¿un bot con escopeta sobrevive a la defensa?» o «¿el tanque salta y aplasta?») y una prueba de
  humo en el navegador. Wilbert juzgaba lo que solo un humano puede juzgar: si se siente bien.
- **Autonomía creciente.** Al principio cada hito esperaba aprobación. Con la confianza ganada, los hitos
  pasaron a avanzar de corrido, con revisión al final.

## Decisiones técnicas que vale la pena contar
- **El mundo es 2D por dentro y 3D solo al dibujarse.** La ciudad es una grilla de casillas (calle, edificio,
  barricada…). Colisiones, visión de los zombies, rutas y sonido se calculan en 2D, que es rapidísimo, y
  Three.js solo levanta la geometría. Por eso agregar la primera persona fue barato: la simulación no cambió,
  solo la cámara.
- **La ciudad como grafo.** Los cruces son nodos y los tramos de calle son aristas. Para cortar calles sin
  dejar al jugador encerrado, cada corte se verifica con una búsqueda en anchura (BFS): si al cortar una
  salida queda inalcanzable, ese corte no se hace.
- **Misma seed, misma ciudad.** Un generador pseudoaleatorio determinista (mulberry32) hace que el mismo
  número dé siempre la misma ciudad. La seed se muestra al ganar o perder, para repetir la partida o
  desafiar a un amigo.
- **Hordas con campos de flujo.** En vez de calcular un camino por zombie (carísimo con cientos), se calcula
  una sola vez un «mapa de direcciones» desde el jugador hacia toda la ciudad, y cada zombie solo mira hacia
  dónde apunta su casilla. Con una grilla espacial para encontrar vecinos, el juego corre a 60 FPS con más
  de 100 zombies.
- **Cientos de zombies animados en pocas llamadas de dibujo.** Cada parte del cuerpo (torso, brazos,
  piernas) se dibuja de una vez para todos los zombies (*instancing*). Cada brazo y pierna gira en el
  hombro o la cadera según cuánto caminó ese zombie. Son 5 dibujos para todos, no 5 por zombie.
- **Estado separado del mundo.** La seed genera solo lo estático. Lo que cambia (zombies, loot recogido,
  vida) vive en una estructura aparte que se puede serializar. Esto deja preparado el multijugador.
- **Sonido sin archivos.** Casi todos los efectos se sintetizan con Web Audio (ruido filtrado,
  osciladores), así que no hay assets de sonido que descargar ni licenciar.

## Números
- 2 días de desarrollo, 15 hitos, más de 40 commits.
- Unas 13.000 líneas de TypeScript en 53 archivos.
- Stack: Vite + TypeScript + Three.js. Sin backend; todo corre en el navegador.
- Gráficos hechos solo con formas básicas: ningún modelo 3D ni textura externa.

## Lo que viene
- **Multijugador cooperativo en web** (planificado para más adelante, no en el v0):
  - Un jugador es el anfitrión y corre la simulación; el otro se conecta con un código de sala (WebRTC).
  - Cada uno elige su cámara (isométrica o primera persona) y cada pantalla sigue a su propio jugador.
  - Habrá «caído y rescate» al estilo Left 4 Dead.
- Se evaluó migrar a Godot y se decidió quedarse en web: es más fácil de compartir (un link) y el prototipo
  demostró que el navegador aguanta.

## Cómo jugarlo
En línea: [ranzcity.wrodriguez.dev](https://ranzcity.wrodriguez.dev) (con `?seed=` se repite una ciudad).
En local:
```
npm install
npm run dev
```
Controles: WASD para moverse, el mouse apunta, clic para disparar, F linterna, E revisar, Shift sigilo,
Espacio dash, M mapa, P primera persona, Esc pausa (ahí está la lista completa).
