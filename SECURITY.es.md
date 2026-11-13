# Política de seguridad

## Versiones soportadas

| Versión | Soporte |
|---|---|
| 1.0.x | Sí |

## Reportar una vulnerabilidad

No abras un issue público. Escribe a **navasfj@gmail.com** con:

- qué componente (dictado, lectura, índice, scripts),
- cómo reproducirlo,
- impacto que crees que tiene,
- versión de DSH y sistema operativo.

Responderé en un plazo razonable y acordaremos la divulgación.

## Alcance

- El código de los plugins y sus scripts.
- La ruta `POST /read-aloud/tts` (autenticada por DSH).
- La descarga y verificación de modelos.

Quedan fuera el propio DeepSeek Harness, `sherpa-onnx-node`, los modelos de
Piper/Whisper y Hugging Face.
