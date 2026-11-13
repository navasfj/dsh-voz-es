# Voz con Whisper (español)

Añade un reconocedor **Whisper local** a la entrada de voz de DeepSeek Harness y
lo deja seleccionado por defecto en español. La interfaz no se duplica: el botón
de micrófono junto a **Enviar**, la animación de onda en tiempo real y la
inserción del texto en el borrador siguen siendo los del bundle de voz de DSH.

## Qué hace

- Registra el proveedor de voz `whisper-local` en el servicio compartido
  `speechToText` del Host.
- Elige `whisper-local` y `es` como selección por defecto, para que el micrófono
  transcriba español sin tener que configurar nada.
- Desactiva SenseVoice, que no reconoce español, para que no aparezca como
  opción en el selector.
- Descarga una sola vez pesos ONNX de Whisper fijados por revisión, tamaño y
  SHA-256, y los reutiliza en los siguientes arranques.
- Mantiene una cola acotada y un proceso de reconocimiento propio: la inferencia
  no bloquea el proceso del Host y se detiene tras un periodo de inactividad.

## Cómo se usa

1. Instala este bundle y el bundle **Voice input** de DSH. Este plugin necesita
   que el bundle de voz esté seleccionado *antes* que él para poder ajustar su
   configuración.
2. Abre **Ajustes de plugins → Voz con Whisper** para ver el estado de los
   modelos. En el primer arranque se descargan los pesos (unos 160 MB con
   `base`); el progreso aparece en la ficha del bundle.
3. Cuando la ficha indique que el reconocedor está listo, pulsa el micrófono
   entre el selector de modelo y **Enviar**.
4. Habla y pulsa **Detener**. El texto reconocido se inserta en el borrador, en
   la posición del cursor, sin borrar el contenido que ya hubiera.
5. Si durante la grabación cambias el borrador, el texto no se inserta solo: se
   ofrece **Insertar** o descartarlo, para no pisar lo que hayas escrito.

La selección de idioma y de tamaño de modelo se guarda en la configuración del
plugin (**Ajustes de plugins → Voz con Whisper**). Los idiomas disponibles salen
del proveedor; `auto` deja que Whisper detecte el idioma.

## Modelos

| Modelo | Peso INT8 aproximado | Calidad en español |
| --- | --- | --- |
| `tiny` | 103 MB | Baja; útil solo para pruebas rápidas |
| `base` | 160 MB | Dictado muy claro |
| `small` | 375 MB | Valor por defecto; mejor con acentos, ruido y frases largas |

Los pesos se guardan en `%USERPROFILE%\.dsh\speech-to-text\whisper\` y se
verifican con SHA-256 antes de usarse. Desinstalar el plugin no borra esa caché.

## Configuración

El patch del bundle expone estas opciones por fila:

- `providerId` (por defecto `whisper-local`): identificador con el que el
  servicio de voz registra este reconocedor.
- `model` (`tiny`, `base`, `small`; por defecto `base`).
- `language` (por defecto `es`): pista de idioma, incluida `auto`.
- `dataRoot`: carpeta de caché; el patch la resuelve con
  `dshHomePath('speech-to-text', 'whisper')`.
- `modelDirectory`: carpeta propia con los tres archivos ONNX ya presentes; en
  ese caso no se descarga ni se verifica nada.
- `threads`, `maxAudioBytes`, `prepareTimeoutMs`, `inferenceTimeoutMs`,
  `idleTimeoutMs`, `maxPending`, `graceMs`, `maxLogBytes`, `maxResponseBytes`,
  `progressIntervalMs` y `autoPrepare`.

## Límites

- Solo CPU. Los pesos INT8 priorizan tamaño y velocidad sobre precisión máxima.
- La grabación está acotada a 120 segundos y 4 MB de WAV, igual que el servicio
  de voz de DSH.
- No hay envío automático, micrófono permanente, palabras de activación ni
  subtítulos en streaming.
- El navegador necesita HTTPS o loopback y permiso de micrófono del sistema.
- El texto solo entra en la conversación cuando tú lo envías; la grabación nunca
  se guarda como evento de sesión ni como adjunto.

## Privacidad

La transcripción ocurre en tu equipo. El audio se envía del navegador al Host
por el canal autenticado de DSH y de ahí al proceso local de Whisper; no sale de
la máquina.

---

# Whisper voice input (Spanish)

Adds a **local Whisper** recognizer to DSH voice input and selects it by default
with Spanish. The microphone button next to **Send**, the live waveform and the
draft insertion remain those of the DSH voice-input bundle.

The provider `whisper-local` registers on the shared `speechToText` service,
downloads revision-pinned ONNX weights once (verified by size and SHA-256), runs
inference in a managed child process, and appends the transcript to the draft at
the cursor without clearing existing text. SenseVoice is disabled because it does
not recognize Spanish. Model sizes: `tiny` (~103 MB), `base` (~160 MB, default),
`small` (~375 MB). Audio stays on the machine and never becomes a Session event.
