/**
 * Private recognition process for the local Whisper provider.
 *
 * The Host passes one JSON object in `argv[2]` with the validated runtime
 * configuration and the verified model paths, and the bearer secret in
 * `DSH_WHISPER_TOKEN`, which is removed from the environment once read.
 * After loading the native recognizer the process binds an ephemeral
 * loopback listener and writes `{"port":N}` plus a newline as its only
 * stdout output. A failure before readiness writes only its message to
 * stderr and exits with code 1. Afterwards the listener keeps the process
 * alive until the Host terminates it.
 */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Invalid recording data; reported to the Host as a marked input rejection. */
class SpeechInputError extends Error {}

/**
 * Resolve sherpa-onnx from the DSH installation.
 *
 * A profile-installed bundle is linked from its source directory, so its
 * `node_modules` lookup does not reach the packaged native runtime. Prefer the
 * runtime that ships with the running installation and keep the ordinary
 * resolution as the last resort.
 *
 * @returns the sherpa-onnx-node module surface.
 */
function loadSherpa() {
  const candidates = []
  const install = process.env.DSH_INSTALL_DIR
  if (install !== undefined && install !== '') candidates.push(join(install, '..', '..'))
  if (typeof process.resourcesPath === 'string') candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'))
  candidates.push(join(process.execPath, '..', 'resources', 'app.asar', 'dsh', 'node_modules'))
  for (const directory of candidates) {
    try {
      return createRequire(join(directory, 'anchor.cjs'))('sherpa-onnx-node')
    } catch {
      // Try the next installation layout.
    }
  }
  return createRequire(import.meta.url)('sherpa-onnx-node')
}

/**
 * Read one ASCII tag at a byte offset.
 * @param view - whole-file view.
 * @param offset - first tag byte.
 * @returns four characters, or an empty string past the end.
 */
function tagAt(view, offset) {
  if (offset + 4 > view.byteLength) return ''
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
}

/**
 * Validate a canonical 16 kHz mono 16-bit PCM WAV and convert it to samples.
 * @param audio - complete recording.
 * @param maxBytes - configured decoded byte limit.
 * @returns normalized samples and their duration.
 */
function decodeWave(audio, maxBytes) {
  if (audio.byteLength < 44) throw new SpeechInputError('Speech audio is too short')
  if (audio.byteLength > maxBytes) throw new SpeechInputError('Speech audio exceeds the configured byte limit')
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  if (tagAt(view, 0) !== 'RIFF' || tagAt(view, 8) !== 'WAVE') throw new SpeechInputError('Speech audio must be a RIFF/WAVE file')
  let offset = 12
  let format, channels, sampleRate, bits, dataOffset = -1, dataSize = 0
  while (offset + 8 <= view.byteLength) {
    const id = tagAt(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + size > view.byteLength) break
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataOffset = body
      dataSize = size
    }
    offset = body + size + (size % 2)
  }
  if (format !== 1 || bits !== 16 || channels !== 1) throw new SpeechInputError('Speech audio must be 16-bit mono PCM')
  if (sampleRate !== 16000) throw new SpeechInputError('Speech audio must be sampled at 16 kHz')
  if (dataOffset < 0 || dataSize < 2) throw new SpeechInputError('Speech audio has no sample data')
  const bytes = Math.min(dataSize, view.byteLength - dataOffset)
  const samples = new Float32Array(bytes >> 1)
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768
  return { samples, audioSeconds: samples.length / 16000 }
}

/**
 * Drop leading and trailing near-silence.
 *
 * Whisper conditions on whatever the clip contains, and a recording that opens
 * or closes with silence is the usual trigger for its repetition loop. Keeping
 * a short margin preserves the first and last phoneme.
 *
 * @param samples - normalized 16 kHz mono samples.
 * @returns the speech region, or the original samples when nothing stands out.
 */
function trimSilence(samples) {
  const frame = 320 // 20 ms at 16 kHz
  const frames = Math.floor(samples.length / frame)
  if (frames < 2) return samples
  const energy = new Float32Array(frames)
  let peak = 0
  for (let index = 0; index < frames; index++) {
    let sum = 0
    for (let offset = 0; offset < frame; offset++) {
      const value = samples[index * frame + offset]
      sum += value * value
    }
    const rms = Math.sqrt(sum / frame)
    energy[index] = rms
    if (rms > peak) peak = rms
  }
  if (peak < 0.002) return samples
  const threshold = Math.max(0.003, peak * 0.12)
  let first = 0
  while (first < frames && energy[first] < threshold) first += 1
  let last = frames - 1
  while (last > first && energy[last] < threshold) last -= 1
  const margin = 8 // 160 ms
  first = Math.max(0, first - margin)
  last = Math.min(frames - 1, last + margin)
  return samples.subarray(first * frame, Math.min(samples.length, (last + 1) * frame))
}

/**
 * Collapse the identical-sentence loop Whisper falls into.
 *
 * Only long consecutive duplicates are removed, so intentional short
 * repetitions ("no, no") survive.
 *
 * @param text - raw transcript.
 * @returns the transcript with the loop removed.
 */
function collapseRepeats(text) {
  const parts = text.match(/[^.!?…]+[.!?…]*/g)
  if (parts === null || parts.length < 2) return text
  const normalize = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?…]+$/, '')
  const kept = []
  let removed = 0
  for (const part of parts) {
    const key = normalize(part)
    if (key.length >= 12 && kept.length > 0 && normalize(kept[kept.length - 1]) === key) {
      removed += 1
      continue
    }
    kept.push(part)
  }
  if (removed === 0) return text
  // The loop often stops mid-sentence: drop the trailing fragment when it is
  // just the beginning of the repeated sentence.
  if (kept.length >= 2) {
    const first = normalize(kept[0])
    const tail = normalize(kept[kept.length - 1])
    if (tail.length >= 4 && tail !== first && first.startsWith(tail)) kept.pop()
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Start the authenticated loopback listener used by the Host.
 * @param token - private per-process authentication secret.
 * @param config - runtime and model configuration.
 * @param paths - verified encoder, decoder and tokenizer paths.
 * @returns the listening server and its dynamically assigned port.
 */
function startServer(token, config, paths) {
  const sherpa = loadSherpa()
  const expected = Buffer.from(`Bearer ${token}`)
  let recognizer
  let language
  /**
   * Build the recognizer on first use and rebuild it when the language changes.
   * @param code - Whisper language code, or an empty string to detect it.
   * @returns the loaded recognizer.
   */
  const recognizerFor = (code) => {
    const requested = code === 'auto' ? '' : code
    if (recognizer !== undefined && language === requested) return recognizer
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: { encoder: paths.encoder, decoder: paths.decoder, language: requested, task: 'transcribe', tailPaddings: 300 },
        tokens: paths.tokens,
        numThreads: config.threads,
        provider: 'cpu',
        debug: 0,
      },
    })
    language = requested
    return recognizer
  }
  /**
   * Recognize one complete recording.
   * @param audio - WAV bytes owned by this request.
   * @param code - language hint chosen by the user.
   * @returns final text and measured durations.
   */
  const transcribe = (audio, code) => {
    const started = performance.now()
    const wave = decodeWave(audio, config.maxAudioBytes)
    const engine = recognizerFor(code)
    const stream = engine.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: trimSilence(wave.samples) })
    engine.decode(stream)
    const text = collapseRepeats(engine.getResult(stream).text.trim())
    return { text, audioSeconds: wave.audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 }
  }
  const server = createServer((request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume()
      reply(401, { error: 'Unauthorized' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'POST' || url.pathname !== '/transcribe') {
      request.resume()
      reply(404, { error: 'Unknown endpoint' })
      return
    }
    const length = Number(request.headers['content-length'])
    if (!Number.isSafeInteger(length) || length < 46 || length > config.maxAudioBytes) {
      request.resume()
      reply(413, { error: 'Invalid speech audio size', code: 'invalid-input' })
      return
    }
    void (async () => {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        reply(200, transcribe(Buffer.concat(chunks), url.searchParams.get('language') ?? config.language))
      } catch (error) {
        reply(error instanceof SpeechInputError ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
          ...error instanceof SpeechInputError ? { code: 'invalid-input' } : {},
        })
      }
    })()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve({ server, port: server.address().port })
    })
  })
}

async function main() {
  const raw = JSON.parse(process.argv[2])
  const token = process.env.DSH_WHISPER_TOKEN
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('DSH_WHISPER_TOKEN is missing or invalid')
  delete process.env.DSH_WHISPER_TOKEN
  const { port } = await startServer(token, raw.config, raw.paths)
  process.stdout.write(`${JSON.stringify({ port })}\n`)
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    // Exit once the message is flushed: a loaded native recognizer would otherwise keep the process alive.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => { process.exit(1) })
  })
}

export { collapseRepeats, trimSilence }
