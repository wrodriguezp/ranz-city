# Hoja de ruta (después del hito 10)

Acordado con Wilbert tras probar el hito 10. Orden: primero arreglar lo que está roto, después sumar.
Lo que más le gusta: la variedad de edificios y escenarios.

## Hito 11: que el sigilo y las hordas funcionen
- **Faroles**: tramos de calle iluminados y otros oscuros. Bajo la luz te ven de lejos aunque vayas agachado;
  el sigilo solo sirve en la oscuridad.
- **Camino iluminado**: la ruta más corta a la salida va bien iluminada (rápida, pero te ven); las rutas
  oscuras son más lentas, pero puedes esconderte.
- **Noche más oscura**: sin linterna se ve apenas un círculo chico alrededor del jugador. Apagarla tiene costo.
- **Alerta en cadena**: si 3 o más zombies te persiguen, gruñen y ese ruido despierta a los cercanos.
  Las hordas van a la última posición donde te vieron y buscan ahí.
- **Comportamientos distintos** para que no formen fila: perseguidor (directo), flanqueador (otra calle, te
  corta el paso), envolvente (se abre en abanico) y acechador (espera en los cruces).
- **Aviso del tanque**: rugido fuerte y distinto al cargar la roca, la roca levantada sobre la cabeza y una
  marca en el suelo donde va a caer.
- **Dash y estamina**: impulso corto con un instante de invulnerabilidad; la estamina se comparte entre correr,
  el dash y los golpes cuerpo a cuerpo.

## Hito 12: juguetes nuevos
- Molotov: zona de fuego temporal que corta una calle.
- Cuerpo a cuerpo: hacha (lenta, decapita), machete (rápido, en abanico), mazo (empuja a varios) y katana
  (rápida, desmiembra); se gastan con el uso, el bate no.
- Desmembramiento sin modelos complejos: el zombie pierde una parte suelta de forma dramática. Sin brazos no
  ataca, sin piernas se arrastra, sin cabeza muere.
- Armas especiales muy raras, con munición propia, que se sueltan al vaciarse: minigun, lanzallamas y
  lanzacohetes.
- Trampas que atraen hordas: alarmas de auto (dispararle a un auto), petardos lanzables, radio encendida.
- Escupidor: ácido a distancia que deja un charco dañino.
- Lanzamiento de suministros: una bengala marca una caja con buen loot que atrae a toda la zona.
- Subfusil tan común como la escopeta (el resto del loot queda como está: que se gaste rápido es divertido).

## Hito 13: escenarios y ambiente
- **Tipos de manzana**: parque (árboles que tapan la vista), estacionamiento (autos y alarmas), gasolinera
  (barriles), construcción (pasillos estrechos), barrio de casas con patios y rejas, retén militar (mejor
  loot, zombies duros), canal con puentes (pasos obligados), hospital (botiquines y un especial).
- Calles cortadas variadas: buses cruzados, escombros, choques de autos, vallas de policía.
- Decoración: autos en llamas, faroles que parpadean, basura, humo, rastros de supervivientes (grafitis
  con flechas a las salidas, campamentos abandonados).
- Clima por seed: lluvia (te oyen menos, ves menos) o niebla.
- Sonido ambiente sintetizado (viento, sirenas y disparos lejanos, perros, gemidos según cuántos zombies hay
  cerca) y música en capas que sube con la tensión (explorar, te vieron, horda). Wilbert genera la música con
  Gemini; los cortes de loop se resuelven con un fundido cruzado entre dos copias.
- **Estado**: hecho, salvo los patios con rejas del barrio de casas (hoy son casas sueltas con techo) y que los
  faroles que parpadean siguen siendo los del hito 11. La música usa explorar/tensión/horda/escape de
  `src/music`; si falta una pista, ese estado usa la de menos intensidad.

## Hito 14: que las armas sirvan y el escape tenga tensión
Feedback de Wilbert: escapar se sentía vacío (te quedas parado en el vehículo) y no se podían usar las armas
porque cada disparo traía a toda la ciudad.
- **Defensa final** (14b): en la salida hay una radio. Mantener E pide la evacuación, y desde ahí hay que
  aguantar 2:30 (helicóptero) o 1:30 (camión) mientras llegan oleadas por un solo lado. La plaza tiene una valla
  con una entrada y el cruce del camión queda como callejón. Hay una caja de munición que se rellena, barriles en
  el embudo y mejor arsenal en la plaza. Mientras defiendes no hay hordas al azar y los disparos se oyen poco.
- **Ritmo** (14c): armas más silenciosas, un director con respiros después de cada horda (y uno extra si la
  despejas), una reserva finita de 220 zombies de horda y un silenciador para la pistola.
- **Botín de los zombies** (14d): los especiales sueltan loot seguido y el tanque un botín grande. El tanque que te
  vio te caza durante 35 s, así que ya no se lo pierde de vista doblando una esquina.
- **La sonámbula** (14e): un especial ciego en la ruta corta. Hay que pasarla agachado y con la linterna apagada.
  Despierta, grita y te caza durante 30 s.
- **Descartado para el prototipo**: personajes articulados (más polígonos). Quedan para la versión en Godot.
- **Pendiente de probar jugando**: el balance de las oleadas. Un bot quieto con escopeta no aguanta el
  helicóptero; las constantes están juntas al principio de `src/game/escape.ts`.

## Para más adelante
- Crescendos: eventos que tú disparas (una alarma, abrir una reja) y que traen una horda a cambio de algo.
- Bloquear calles empujando objetos (complementa el sigilo; hay que diseñarlo).
- Perro compañero (duda: ladrar atraería a la horda; quizás gruñe bajito).
- Progreso entre partidas tipo roguelite (para la versión final).
- Supervivientes vivos y autos que se mueven.

## Descartado
- Refugios (ya hay botiquines), superpoderes y mejoras, cámara en primera o tercera persona.
