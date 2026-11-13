# Atribuciones y licencias de terceros

Este repositorio contiene código propio bajo licencia MIT. Los modelos y el
runtime que descarga en tiempo de ejecución pertenecen a sus autores:

## Piper — voz `es_ES-sharvard-medium`

- Modelo: [csukuangfj/vits-piper-es_ES-sharvard-medium](https://huggingface.co/csukuangfj/vits-piper-es_ES-sharvard-medium), conversión a ONNX para sherpa-onnx.
- Proyecto Piper: [rhasspy/piper](https://github.com/rhasspy/piper) (MIT).
- Datos de entrenamiento: corpus «sharvard» — [datashare.ed.ac.uk/handle/10283/574](https://datashare.ed.ac.uk/handle/10283/574), licencia **CC BY 3.0**. El MODEL_CARD del modelo lo declara.
- `espeak-ng` (fonemización): **GPLv3**. Este repositorio **no redistribuye** espeak-ng; el modelo descarga sus datos desde Hugging Face en tiempo de ejecución.

## Whisper — modelos ONNX

- Modelos originales: [OpenAI Whisper](https://github.com/openai/whisper) (MIT).
- Conversión y distribución ONNX: repositorio [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) de k2-fsa.

## sherpa-onnx / sherpa-onnx-node

- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), licencia **Apache-2.0**. Se usa desde la instalación de DeepSeek Harness; este repositorio no lo incluye.

## DeepSeek Harness

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), licencia MIT. Los plugins usan sus APIs de extensión (`speechToText`, slots, `uiConversation`, rutas web autenticadas).
