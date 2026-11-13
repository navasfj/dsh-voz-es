# Leer respuestas en voz alta

Añade un botón de altavoz a la barra del cuadro de texto. Mientras está activo,
cada respuesta del asistente que termina se lee en voz alta; al pulsarlo de nuevo
se silencia y se pausa la lectura.

## Voz

Usa **Piper** (`es_ES-sharvard-medium`), una voz neuronal local que suena mucho
más natural que las voces SAPI que expone el navegador y que las voces OneCore de
Windows. La síntesis la hace el Host con sherpa-onnx; el navegador solo reproduce
el WAV.

- El modelo ocupa ~77 MB y se descarga **una sola vez**, fijado por revisión y
  verificado por tamaño y SHA-256.
- Se guarda en `%USERPROFILE%\.dsh\read-aloud\models\piper-es-sharvard\`.
- La velocidad se ajusta en la configuración del plugin (`speed`; 0.9 por
  defecto, menos de 1 habla más despacio).

```yaml
- id: ui-read-aloud
  name: "@navasfj/dsh-read-aloud"
  config:
    speed: 0.9      # 0.8 = más lento, 1.0 = ritmo natural de Piper
    threads: 4      # hilos de CPU para la síntesis
```

## Qué hace

- Botón compacto con dos estados, sin fondo en ninguno de los dos:
  - **Activo**: altavoz con ondas en **verde** (`--dsw-alias-state-success-primary`).
  - **Silenciado**: altavoz tachado en **rojo** (`--dsw-alias-state-error-primary`).
  `aria-pressed` refleja el estado y el tooltip dice **Leer** o **Silenciar**.
- Lee solo cuando la respuesta está **asentada** (terminada), no mientras se
  escribe.
- Lee únicamente los bloques de texto visibles: omite razonamiento, llamadas a
  herramientas y bloques de código.
- **Prefetch**: mientras suena un fragmento, el siguiente ya se está
  sintetizando, así que las respuestas largas no tienen silencios entre trozos.
- Reproduce con un elemento de audio real, así que **silenciar pausa de verdad**
  y reanudar continúa exactamente donde se quedó (sin repetir la frase).
- Si el mute dura **más de 5 segundos**, se descarta el relato pendiente: al
  reactivar ya no se reproduce nada y queda listo para la siguiente respuesta.
- La preferencia se guarda en el navegador: si la dejas activa, sigue activa
  tras recargar.
- Al activarla no relee el historial: solo las respuestas que terminen a partir
  de ese momento.

## Cómo se usa

1. Pulsa el altavoz de la barra del cuadro de texto, pegado al micrófono.
2. Haz una pregunta: cuando la respuesta termine, se leerá.
3. Pulsa el altavoz otra vez para silenciarla: se pausa. Vuelve a pulsarlo en
   menos de 5 segundos para continuar; si tardas más, se descarta.

## Aspecto

Mismo lenguaje visual que el micrófono: botón compacto de 28 px con icono de
línea que llena su caja, y un tooltip oscuro encima al pasar el ratón. El color
del icono indica el estado (verde con ondas al leer, rojo tachado en mute) y no
lleva fondo en ninguno de los dos casos.

El botón se coloca en el mismo grupo de controles de la barra, inmediatamente a
la izquierda del micrófono. DSH reserva un único asiento para la acción que va
justo antes de Enviar y lo ocupa el micrófono, así que no existe un hueco
publicado a su derecha; esta es la posición adyacente más cercana.

## Límites

- La primera síntesis de una sesión tarda algo más (arranque del proceso y carga
  del modelo); después va fluido.
- La síntesis corre en CPU: en respuestas muy largas, el primer fragmento puede
  tardar unos segundos en sonar mientras se genera.
- No hay selector de voz en la interfaz; el modelo es una voz femenina española.
- No lee el texto del usuario ni el razonamiento del modelo, solo la respuesta
  final.
- La lectura requiere la pestaña abierta; no se reproduce en segundo plano ni se
  guarda en la sesión.

## Privacidad

La síntesis ocurre en tu equipo. El texto viaja del navegador al Host por el
canal autenticado de DSH y de ahí al proceso local de Piper; no se envía a
ningún servicio de red. La descarga del modelo sí usa Hugging Face una vez.

---

# Read assistant replies aloud

Adds a speaker toggle to the composer toolbar. While active, every assistant
reply that settles is read aloud with a local Piper voice (`es_ES-sharvard-medium`)
synthesized by the Host through sherpa-onnx; the page plays the WAV with a real
audio element, so mute pauses and resume continues exactly where it stopped. The
~77 MB model is downloaded once from a pinned revision, verified by size and
SHA-256, and stored under the DSH home. The next chunk is prefetched while the
current one plays, and a mute longer than five seconds discards the pending
narration. The text never leaves the machine.
