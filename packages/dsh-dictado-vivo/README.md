# @navasfj/dsh-dictado-vivo

Dictado en vivo para el compositor de DeepSeek Harness: el texto aparece en el
cuadro de mensaje **mientras hablas** y, al parar, Whisper reescribe el resultado
definitivo.

- **Streaming**: Kroko español (sherpa-onnx, Zipformer RNN-T), local y sin red.
- **Final**: el proveedor Whisper configurado en DSH.
- Se activa y desactiva como cualquier plugin; al desactivarlo vuelve el
  micrófono original.

Instalación:

```bash
pnpm add "link:<ruta-al-paquete>"
```

y añade el bundle a `dsh.profile.bundles` del perfil (`dsl` lo hace solo desde el
gestor de plugins).
