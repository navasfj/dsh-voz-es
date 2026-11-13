# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/).

## [1.0.0] — 2026-11-13

### Añadido

- `dsh-whisper-voice`: proveedor `whisper-local` para el micrófono de DeepSeek
  Harness, con Whisper ONNX (sherpa-onnx), descarga verificada por SHA-256 y
  proceso hijo propio.
- `dsh-read-aloud`: lectura de las respuestas con Piper
  (`es_ES-sharvard-medium`), botón junto al micrófono, icono verde/rojo,
  pausa/reanudación real, descarte tras 5 s de mute y prefetch del siguiente
  fragmento.
- Índice de plugins (`index.json`) para la pestaña Discover.
- CI de GitHub Actions con comprobación de sintaxis y manifiestos.
- Scripts para regenerar las imágenes (`scripts/make-assets.py`) y el índice
  (`scripts/make-index.mjs`).

### Notas

- Probado en Windows 11 con DSH `0.2.2-rc.2` y `0.2.2-rc.3`.
- El dictado necesita el bundle **Voice input** de DSH activo.
