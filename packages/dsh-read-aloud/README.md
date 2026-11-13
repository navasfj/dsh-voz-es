# @navasfj/dsh-read-aloud

Botón de lectura en voz alta de las respuestas del asistente para DeepSeek
Harness, con una voz neuronal local (Piper) y pausa/reanudación real.

## Cómo funciona

- **Host** ([index.js](index.js)): descarga y verifica el modelo Piper
  ([runtime/assets.json](runtime/assets.json), ~77 MB, fijado por revisión y
  SHA-256), arranca un proceso de síntesis ([tts-worker.js](tts-worker.js)) y
  registra `POST /read-aloud/tts` detrás del filtro de autenticación de
  `ctx.connection`. Recibe `{ text }` y devuelve el WAV.
- **Worker**: carga `OfflineTts` (VITS/Piper) de sherpa-onnx y escucha en
  loopback con token; `generate({ text, speed, enableExternalBuffer: false })`
  y codifica el WAV en memoria. Se detiene tras 5 minutos de inactividad.
- **Cliente** ([client.js](client.js)): registra el botón en
  `conversation.input.right`, se suscribe al snapshot público del Chat con
  `ctx.uiConversation.binding(sessionId).snapshot`, detecta nodos
  `assistant-step` en estado `settled`, limpia el Markdown, trocea el texto en
  peticiones de hasta 800 caracteres y reproduce cada WAV con `new Audio(url)`.
- **Prefetch**: al empezar a sonar un trozo se pide el siguiente, para que las
  respuestas largas no tengan silencios.
- Silenciar pausa el elemento de audio; reanudar lo reanuda. Un mute de más de
  5 s descarta la cola y el audio actual.
- La preferencia se guarda en `localStorage` (`dsh:read-aloud:enabled`).

## Configuración

```yaml
- id: ui-read-aloud
  name: "@navasfj/dsh-read-aloud"
  config:
    speed: 0.9      # 0.8 = más lento, 1.0 = ritmo natural
    threads: 4
```

## Por qué no `speechSynthesis`

Chromium en Windows solo ve las voces SAPI (Helena Desktop), muy enlatadas.
Piper es una voz neuronal local que no necesita red en tiempo de uso; además un
elemento de audio da pausa/reanudación real y un evento `ended` fiable.

## Limitaciones conocidas

- La síntesis corre en CPU; el primer fragmento de una sesión tarda unos
  segundos en sonar.
- Solo hay una voz (es_ES-sharvard-medium, femenina).
- Depende de la forma del snapshot `chat` (`nodes.values()` con
  `kind: 'assistant-step'`); si una versión de DSH la cambia, hay que ajustar
  `client.js`.
