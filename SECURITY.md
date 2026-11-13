# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |

## Reporting a vulnerability

Do not open a public issue. Email **navasfj@gmail.com** with:

- which component (dictation, read-aloud, index, scripts),
- how to reproduce it,
- the impact you think it has,
- DSH version and operating system.

I will reply within a reasonable time and we will agree on disclosure.

## Scope

- The plugins' code and their scripts.
- The `POST /read-aloud/tts` route (authenticated by DSH).
- Model download and verification.

Out of scope: DeepSeek Harness itself, `sherpa-onnx-node`, the Piper/Whisper
models and Hugging Face.
