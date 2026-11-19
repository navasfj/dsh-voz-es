# Dictado en vivo

Sustituye el micrófono de la barra del mensaje por uno que **escribe mientras
hablas**, como el dictado de Gemini o ChatGPT, y al parar deja el texto bueno.

## Cómo funciona

Dos modelos, cada uno en lo que es bueno:

1. **Mientras hablas** — un modelo **Kroko español** en streaming (Zipformer
   RNN-T, sherpa-onnx) decodifica trozos de 320 ms y el texto va apareciendo en el
   cuadro de mensaje. Es rápido (unas diez veces más rápido que el tiempo real en
   este PC) y puntúa solo.
2. **Al parar** — el audio completo pasa por el proveedor **Whisper** configurado
   en DSH, que reescribe el texto provisional con el definitivo. Si Whisper no
   entiende nada, se queda el texto del streaming.

El texto provisional se escribe a través de la cara pública del compositor
(`captureInsertion` / `insertText`), así que nunca se toca el DOM de otro plugin,
y cada actualización reemplaza solo el fragmento que escribió el dictado: lo que
hubiera antes en el cuadro se respeta.

## Modelo

- **Kroko español** (`csukuangfj/sherpa-onnx-streaming-zipformer-es-kroko`),
  ~155 MB, licencia **CC-BY-SA-4.0** (modelos Kroko de Banafo).
- Se descarga **una sola vez**, fijado por revisión y verificado por tamaño y
  SHA-256, en `%USERPROFILE%\.dsh\dictado-vivo\models\kroko-es\`.
- La primera vez tarda un poco; el botón muestra el progreso de la descarga.

## Configuración

```yaml
- id: dictado-vivo
  name: "@navasfj/dsh-dictado-vivo"
  config:
    threads: 4        # hilos de CPU para el streaming
    language: es      # idioma del dictado y del texto final
```

## Encender y apagar

Es un plugin más: se activa o desactiva desde el **gestor de plugins**. Al
desactivarlo, el bundle de voz de DSH recupera su micrófono de siempre y el
dictado vuelve a escribir solo al parar.

## Detalles

- La grabación se corta sola a los **120 s**, como el micrófono original.
- `Esc`, perder el foco o cambiar de pestaña cancelan el dictado y borran el
  texto provisional.
- Si escribes mientras dictas, el dictado deja de reemplazar el texto (no pisa lo
  que has escrito) y al parar te ofrece el resultado con el botón **Insertar**.
- La lectura en voz alta se pausa mientras dictas, igual que antes: el plugin de
  lectura observa el estado del dictado.
