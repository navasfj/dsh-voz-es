# Cómo contribuir

Gracias por querer mejorar `dsh-voz-es`. Este proyecto son dos plugins para
DeepSeek Harness; antes de tocar nada, instálalos y pruébalos como usuario.

[English](CONTRIBUTING.md)

## Antes de abrir un issue

- Lee [README.es.md](README.es.md), sobre todo **Requisitos** y **Problemas frecuentes**.
- Comprueba que el bundle **Voice input** de DSH está activo (para el dictado).
- Indica la versión de DSH (`0.2.2-rc.3`, etc.), el sistema operativo y qué plugin
  falla.

## Pull requests

1. Abre un issue antes de cambios grandes, para acordar el enfoque.
2. Un cambio por PR, con una descripción de qué y por qué.
3. Pasa las comprobaciones:

   ```bash
   node --check packages/dsh-whisper-voice/index.js
   node --check packages/dsh-whisper-voice/worker.js
   node --check packages/dsh-read-aloud/index.js
   node --check packages/dsh-read-aloud/tts-worker.js
   node --check packages/dsh-read-aloud/client.js
   ```

4. Si cambias el comportamiento, actualiza `CHANGELOG.md` y el README.
5. Si tocas los modelos o las rutas, mantén la verificación por tamaño y SHA-256.

## Estilo

- JavaScript ESM, sin dependencias nuevas salvo que sea imprescindible.
- Los plugins de cliente deben seguir el formato `window.__ModuleLoader__.load`.
- Nada de rutas absolutas de tu equipo en el código ni en la documentación.
- Documentación de usuario en español e inglés; nombres de código en inglés.

## Seguridad

No publiques credenciales, tokens ni datos personales en issues o PRs. Para
vulnerabilidades, sigue [SECURITY.es.md](SECURITY.es.md).
