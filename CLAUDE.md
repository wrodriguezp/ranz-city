# Proyecto: Zombie City (prototipo v0)

## La idea
Shooter de zombies en 3D con cámara isométrica fija (estilo twin-stick: WASD para moverse, el personaje apunta
y dispara hacia el mouse). La ciudad es **finita** y se genera proceduralmente a partir de una seed: cada partida
es una ciudad distinta, pero siempre con límites.
Mezcla del ritmo de Left 4 Dead 2 (avanzar, matar hordas, llegar a una zona de escape, infectados
especiales) con el loot y la exploración de Project Zomboid.
A diferencia de L4D2, el mapa no es lineal: la ciudad es un laberinto urbano con calles cortadas, y el jugador
elige su ruta según el riesgo que quiera asumir.

Pilares de diseño (en orden de prioridad):
1. **Estrés por no ver**: noche, linterna con cono de luz y sombras reales proyectadas por las paredes.
2. **Hordas**: muchos zombies a la vez, que se sienta abrumador.
3. **Rutas con riesgo/recompensa**: varias rutas hacia la salida. Por ejemplo, una corta con un super zombie
   y otra larga con hordas de zombies normales. La dificultad sube a medida que te acercas a una salida.
4. **Escape**: puede haber varias salidas (p. ej. un helicóptero en una plaza), cada una más lejana o más custodiada.
   La partida termina al escapar o al morir.
5. **Loot**: revisar autos, cajas y cuerpos de supervivientes en la calle para encontrar munición, botiquines y
   baterías de linterna.

Ideas para más adelante (fuera del v0): entrar a los edificios (interiores con techo que se oculta),
supervivientes vivos (aliados o enemigos), conducir autos, más infectados especiales y multijugador cooperativo.

## Alcance del prototipo v0 (solo esto, nada más)
El objetivo es validar si la idea **es divertida**, no construir el juego final.
- Un jugador, sin multijugador.
- Solo exteriores: los edificios son bloques sólidos, no se entra a ellos.
- 3D con cámara ortográfica en ángulo isométrico.
- Gráficos con formas básicas (cajas, cilindros, cápsulas), sin assets.

## Stack
- Vite + TypeScript + Three.js
- Se ejecuta en el navegador con `npm run dev`
- Sin backend en v0

## Hitos (cada uno debe poder jugarse antes de pasar al siguiente)
1. **Ciudad**: generación con una seed (PRNG determinista, p. ej. mulberry32) de una ciudad finita de manzanas
   y calles. Calles cortadas con barricadas, verificando con BFS que siempre exista un camino del inicio a cada salida.
   Salidas marcadas. La misma seed debe dar siempre la misma ciudad. Se ve en 3D con una cámara libre para revisarla.
2. **Jugador**: movimiento con WASD, apuntar con el mouse (rayo al plano del suelo), colisión con paredes y
   barricadas, y cámara isométrica que lo sigue.
3. **Oscuridad**: noche con luz ambiental mínima y linterna (`SpotLight` con sombras) que apunta hacia el mouse.
4. **Zombies**: zombies que deambulan, persiguen al jugador cuando lo ven o lo oyen, y hordas por ruido o tiempo.
   Tiene que rendir bien con más de 100 zombies (`InstancedMesh` para dibujar y grilla espacial para los vecinos).
5. **Combate**: un arma cuerpo a cuerpo y una pistola con munición limitada. Vida del jugador.
6. **Zonas y rutas**: la dificultad sube cerca de las salidas. Un primer infectado especial (un "tanque" lento y duro)
   se ubica en un punto de paso obligado de la ruta corta, y las rutas largas tienen más hordas.
7. **Loot y mapa**: autos, cajas y cuerpos con loot aleatorio (vía seed), un inventario mínimo y un mapa
   con la posición del jugador y las salidas.
8. **Escape**: helicóptero en una plaza y otras salidas. Pantallas de victoria y derrota, con la seed visible
   para poder repetir una partida.
   **Reloj de evacuación**: la partida tiene una hora en el juego y cada salida tiene una hora límite.
   Mientras más cerca está la salida, antes se va. Si llegas tarde, esa salida ya no sirve. La más lejana
   espera al jugador sin límite, así que siempre queda una opción. Esto también resuelve que el camino a una
   salida pase por otra: pasar por la cercana fuera de hora no te saca. Los tiempos tienen que ser holgados:
   el reloj es para presionar, no para impedir pelear con los zombies.

## Decisiones técnicas que hay que respetar
- **El mundo es 2D por dentro y 3D solo al dibujarse.** La ciudad se guarda como una grilla de tiles
  (calle, edificio, barricada, etc.). Colisiones, línea de visión de los zombies, pathfinding y grilla espacial
  se calculan sobre esa grilla 2D. El renderer de Three.js lee la grilla y levanta la geometría 3D.
- **La red de calles se modela como un grafo** (cruces como nodos, tramos de calle como aristas) para cortar
  calles, garantizar caminos y clasificar rutas.
- **La seed genera solo el mundo estático.** El estado dinámico (loot ya recogido, zombies) vive aparte, en una
  estructura serializable. Esto prepara el terreno para el multijugador futuro, donde el host será la autoridad
  sobre ese estado.
- La lógica del juego debe quedar separada del renderizado.
- Código en inglés y comentarios en español.

## Forma de trabajar
- Antes de implementar cada hito, presentar un plan corto y esperar aprobación.
- Trabajar un hito a la vez, con commits pequeños.
- Explicar las decisiones no obvias (generación procedural, grafos/BFS, iluminación, pathfinding): el desarrollador
  quiere entender el código, no solo recibirlo.
