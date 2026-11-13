# Contributing

Thanks for improving `dsh-voz-es`. This project is two plugins for DeepSeek
Harness; install them and use them as a user before changing anything.

[Español](CONTRIBUTING.es.md)

## Before opening an issue

- Read [README.md](README.md), especially **Requirements** and **Troubleshooting**.
- Check that DSH's **Voice input** bundle is enabled (for dictation).
- Include the DSH version (`0.2.2-rc.3`, etc.), your OS and which plugin fails.

## Pull requests

1. Open an issue before large changes so we can agree on the approach.
2. One change per PR, with a description of what and why.
3. Run the checks:

   ```bash
   node --check packages/dsh-whisper-voice/index.js
   node --check packages/dsh-whisper-voice/worker.js
   node --check packages/dsh-read-aloud/index.js
   node --check packages/dsh-read-aloud/tts-worker.js
   node --check packages/dsh-read-aloud/client.js
   ```

4. If behavior changes, update `CHANGELOG.md` and the README.
5. If you touch models or paths, keep the size and SHA-256 verification.

## Style

- JavaScript ESM, no new dependencies unless strictly necessary.
- Client plugins must keep the `window.__ModuleLoader__.load` format.
- No absolute paths from your machine, neither in code nor in docs.
- User-facing docs in Spanish and English; code and comments in English.

## Security

Do not post credentials, tokens or personal data in issues or PRs. For
vulnerabilities, follow [SECURITY.md](SECURITY.md).
