# dsh-voz-es — Voz en español para DeepSeek Harness

Dos plugins locales para [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):

| Paquete | Qué hace |
|---|---|
| [`packages/dsh-whisper-voice`](packages/dsh-whisper-voice) | **Dictado** con Whisper local en español. Añade un reconocedor `whisper-local` al micrófono de DSH y sustituye a SenseVoice, que no reconoce español. |
| [`packages/dsh-read-aloud`](packages/dsh-read-aloud) | **Lectura en voz alta** de las respuestas con Piper (voz neuronal local), botón junto al micrófono, mute con pausa/reanudación y descarte a los 5 s. |

Todo ocurre en tu equipo: ni el audio ni el texto salen a ningún servicio. Los modelos se descargan una vez desde Hugging Face y se verifican por tamaño y SHA-256.

## Requisitos

- **DSH 0.2.2.x** (probado en `0.2.2-rc.2` y `0.2.2-rc.3`).
- `sherpa-onnx-node`, que ya viene con la instalación de DSH (lo usa su bundle de voz).
- Para el **dictado**, activa antes el bundle **Voice input** de DSH: el plugin de Whisper ajusta sus filas (`speech-to-text` y SenseVoice) y necesita que existan.
- Probado en **Windows 11**. El motor soporta macOS y Linux, pero no se ha probado en ellos.

## Instalación

### Desde este repositorio (Git)

En DSH, **Plugins → Añadir plugin** con la ruta local del paquete, o con el gestor de plugins usando una spec Git fijada a un commit:

```
git+https://github.com/Navasfj/dsh-voz-es.git#<commit>&path:/packages/dsh-read-aloud
git+https://github.com/Navasfj/dsh-voz-es.git#<commit>&path:/packages/dsh-whisper-voice
```

Para el dictado, el orden importa: primero activa **Voice input** (Plugins), después instala `dsh-whisper-voice`.

### Desde un índice de plugins (Discover)

Activa el bundle de índices personalizados, añade la URL del índice y verás las fichas con botón de instalar:

```
https://raw.githubusercontent.com/Navasfj/dsh-voz-es/main/index.json
```

Genera o actualiza ese índice con:

```bash
node scripts/make-index.mjs
```

### Desde npm (opcional)

Los paquetes están preparados para publicarse; cambia el scope si tu usuario de npm no es `navasfj` y publica cada uno:

```bash
cd packages/dsh-read-aloud && npm publish --access public
cd ../dsh-whisper-voice && npm publish --access public
```

## Uso

1. **Dictar**: pulsa el micrófono entre el selector de modelo y Enviar, habla y pulsa Detener. El texto se añade al borrador en el cursor sin borrar lo que ya hay.
2. **Leer**: pulsa el altavoz junto al micrófono. Verde con ondas = lee; rojo tachado = silenciado. Silenciar pausa; volver a pulsar en menos de 5 s continúa donde iba; si tardas más, descarta el relato pendiente.

## Modelos y caché

| Modelo | Tamaño | Dónde |
|---|---|---|
| Whisper `small` (INT8) | ~375 MB | `%USERPROFILE%\.dsh\speech-to-text\whisper\models\whisper-small` |
| Piper `es_ES-sharvard-medium` + espeak | ~77 MB | `%USERPROFILE%\.dsh\read-aloud\models\piper-es-sharvard` |

La primera vez que se usa cada plugin se descarga su modelo. El dictado admite `tiny`/`base`/`small` por configuración; la lectura ajusta la velocidad con `speed` (0.9 por defecto).

## Privacidad

- El audio del micrófono va del navegador al Host por el canal autenticado de DSH y de ahí al proceso local de Whisper.
- La lectura sintetiza en el Host con Piper y el navegador reproduce el WAV.
- No hay telemetría ni peticiones a servicios de voz. La única red que se usa es la descarga inicial del modelo desde Hugging Face.

## Estructura

```
packages/dsh-whisper-voice/   proveedor Whisper + worker sherpa-onnx + assets verificados
packages/dsh-read-aloud/      botón de lectura + worker Piper + ruta autenticada /read-aloud/tts
scripts/make-index.mjs        genera index.json para Discover
index.json                    índice de plugins (formato 1)
```

## Licencia y atribuciones

Código MIT (ver [LICENSE](LICENSE)). Los modelos y el runtime tienen sus licencias: ver [NOTICE.md](NOTICE.md).

---

Local Spanish voice for DeepSeek Harness: Whisper dictation and Piper read-aloud, both on-device. Requires DSH 0.2.2.x and the shipped `sherpa-onnx-node`; enable the Voice input bundle before installing the Whisper provider. Models download once and are verified by SHA-256. Code MIT.
