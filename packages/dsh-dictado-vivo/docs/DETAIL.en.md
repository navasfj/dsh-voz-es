# Live dictation

Replaces the composer microphone with one that **writes while you speak**, like
Gemini or ChatGPT dictation, and leaves the good text behind when you stop.

## How it works

Two models, each doing what it is good at:

1. **While you speak** — a **Spanish Kroko** streaming model (Zipformer RNN-T on
   sherpa-onnx) decodes 320 ms chunks and the text grows in the composer. It runs
   about ten times faster than real time on this machine and punctuates by itself.
2. **When you stop** — the whole recording goes through the configured **Whisper**
   provider, which rewrites the provisional text with the final one. If Whisper
   hears nothing, the streaming text stays.

Provisional text goes through the composer's public input face
(`captureInsertion` / `insertText`), so the plugin never touches another plugin's
DOM, and every update replaces only the fragment the dictation wrote: whatever was
already in the composer is preserved.

## Model

- **Kroko Spanish** (`csukuangfj/sherpa-onnx-streaming-zipformer-es-kroko`),
  ~155 MB, **CC-BY-SA-4.0** (Banafo's Kroko models).
- Downloaded **once**, revision-pinned and verified by size and SHA-256, into
  `%USERPROFILE%\.dsh\dictado-vivo\models\kroko-es\`.
- The first click shows download progress.

## Configuration

```yaml
- id: dictado-vivo
  name: "@navasfj/dsh-dictado-vivo"
  config:
    threads: 4        # CPU threads for streaming
    language: es      # dictation and final transcript language
```

## Turning it off

It is a normal plugin: enable or disable it in the **plugin manager**. Disabled,
DSH's own voice bundle gets its microphone back and dictation only writes when you
stop, exactly as before.
