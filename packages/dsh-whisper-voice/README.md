# @navasfj/dsh-whisper-voice

Proveedor de reconocimiento **Whisper local** para el micrófono de entrada de voz
de DeepSeek Harness, con español.

## Por qué existe

El bundle de voz de DSH trae SenseVoice, que reconoce chino, inglés, cantonés,
japonés y coreano, pero **no español**. Este bundle reutiliza toda esa interfaz
(botón, waveform, inserción en el borrador) y sustituye el reconocedor por
Whisper, que sí reconoce español.

## Cómo se compone

El patch del bundle:

1. Sobrescribe la fila `speech-to-text` para usar `whisper-local` y `es`.
2. Desactiva la fila `speech-to-text-sensevoice`.
3. Inserta la fila `speech-to-text-whisper`, que monta este paquete con
   `dataRoot` bajo el home de DSH.

Requiere que `@deepseek-ai/dsh-experimental-voice-input-bundle` esté seleccionado
antes en `dsh.profile.bundles`, porque las capas se aplican en ese orden.

## Archivos

- `index.js`: el plugin de Host (proveedor, preparación, cola, proceso hijo).
- `worker.js`: proceso privado que carga sherpa-onnx y atiende loopback.
- `runtime/assets.json`: pesos ONNX fijados por revisión, tamaño y SHA-256.
- `cordis.patch.yml`: la composición descrita arriba.
- `locale/`, `icon.svg`, `docs/DETAIL.md`: metadatos de la ficha del plugin.

## Runtime

Resuelve `sherpa-onnx-node` desde la instalación de DSH (la app ya lo incluye),
sin instalar una segunda copia. Si el layout no se encuentra, cae a la resolución
normal de Node.

## Verificación manual

```powershell
# El proceso de inferencia imprime {"port":N} y sirve POST /transcribe.
node worker.js '{"config":{"language":"es","threads":2,"maxAudioBytes":4194304},"paths":{"encoder":"...","decoder":"...","tokens":"..."}}'
```
