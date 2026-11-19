/**
 * Private streaming recognizer for the live dictation plugin.
 *
 * The Host passes one JSON object in `argv[2]` with the validated runtime
 * configuration and the verified model paths, and the bearer secret in
 * `DSH_DICTADO_TOKEN`, which is removed from the environment once read. After
 * loading the model the process binds an ephemeral loopback listener and writes
 * `{"port":N}` plus a newline as its only stdout output.
 *
 * Each dictation owns one online stream. The page posts 16-bit mono PCM chunks
 * every few hundred milliseconds and reads back the text decoded so far, which
 * is exactly what makes the words appear while the user is still speaking.
 */
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Invalid chunk data; reported to the Host as a marked input rejection. */
class ChunkError extends Error {}

/**
 * Resolve sherpa-onnx from the DSH installation.
 *
 * A profile-installed bundle is linked from its source directory, so its
 * `node_modules` lookup does not reach the packaged native runtime.
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
 * Convert little-endian 16-bit PCM into normalized samples.
 * @param buffer - one posted chunk.
 * @returns mono samples in [-1, 1].
 */
function decodePcm(buffer) {
  const samples = new Float32Array(buffer.length >> 1)
  for (let index = 0; index < samples.length; index++) samples[index] = buffer.readInt16LE(index * 2) / 32768
  return samples
}

/**
 * Collapse a phrase the decoder got stuck repeating.
 *
 * Greedy decoding of a long silence or a noisy tail can settle into replaying
 * the same block of words. Only blocks of two or more words are collapsed, so a
 * deliberate "no, no, no" survives.
 * @param text - decoded text.
 * @returns the text with repeated blocks reduced to one.
 */
function collapseStreamingRepeats(text) {
  const words = text.split(/\s+/).filter((word) => word !== '')
  if (words.length < 6) return words.join(' ')
  const kept = []
  let index = 0
  while (index < words.length) {
    let repeated = false
    for (let size = 8; size >= 2; size--) {
      if (index + size * 3 > words.length) continue
      const block = words.slice(index, index + size).join(' ')
      if (words.slice(index + size, index + size * 2).join(' ') !== block) continue
      if (words.slice(index + size * 2, index + size * 3).join(' ') !== block) continue
      kept.push(...words.slice(index, index + size))
      index += size * 3
      while (index + size <= words.length && words.slice(index, index + size).join(' ') === block) index += size
      repeated = true
      break
    }
    if (!repeated) {
      kept.push(words[index])
      index += 1
    }
  }
  return kept.join(' ')
}

/**
 * Start the authenticated loopback listener used by the Host.
 * @param token - private per-process authentication secret.
 * @param config - runtime configuration from the Host.
 * @param paths - verified encoder, decoder, joiner and tokenizer paths.
 * @returns the listening server and its dynamically assigned port.
 */
function startServer(token, config, paths) {
  const sherpa = loadSherpa()
  const expected = Buffer.from(`Bearer ${token}`)
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
      tokens: paths.tokens,
      numThreads: config.threads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: false,
    maxActivePaths: 4,
  })
  /** One open dictation per id; the page closes it explicitly. */
  const streams = new Map()

  /**
   * Drain every ready frame so the result covers all accepted audio.
   * @param stream - online stream to decode.
   */
  const drain = (stream) => {
    while (recognizer.isReady(stream)) recognizer.decode(stream)
  }
  /**
   * Read the text decoded so far.
   * @param stream - online stream.
   * @returns trimmed transcript.
   */
  const textOf = (stream) => collapseStreamingRepeats(recognizer.getResult(stream).text.trim())

  const server = createServer((request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
    }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume()
      reply(401, { error: 'Unauthorized' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname
    const id = url.searchParams.get('id') ?? ''
    if (path === '/ping') {
      request.resume()
      reply(200, { ok: true, streams: streams.size })
      return
    }
    if (request.method !== 'POST') {
      request.resume()
      reply(405, { error: 'Method not allowed' })
      return
    }
    if (path === '/open') {
      request.resume()
      if (streams.size >= config.maxStreams) {
        reply(429, { error: 'Too many open dictations' })
        return
      }
      const stream = recognizer.createStream()
      const streamId = randomUUID()
      streams.set(streamId, stream)
      reply(200, { id: streamId })
      return
    }
    if (path !== '/chunk' && path !== '/close') {
      request.resume()
      reply(404, { error: 'Unknown endpoint' })
      return
    }
    const stream = streams.get(id)
    if (stream === undefined) {
      request.resume()
      reply(410, { error: 'Unknown dictation' })
      return
    }
    const length = Number(request.headers['content-length'] ?? 0)
    if (path === '/chunk' && (!Number.isSafeInteger(length) || length < 2 || length > config.maxChunkBytes)) {
      request.resume()
      reply(413, { error: 'Invalid chunk size', code: 'invalid-input' })
      return
    }
    void (async () => {
      try {
        if (path === '/chunk') {
          const chunks = []
          let total = 0
          for await (const chunk of request) {
            total += chunk.length
            if (total > config.maxChunkBytes) throw new ChunkError('Chunk exceeds the configured byte limit')
            chunks.push(chunk)
          }
          const samples = decodePcm(Buffer.concat(chunks))
          if (samples.length === 0) throw new ChunkError('Chunk has no samples')
          stream.acceptWaveform({ sampleRate: 16000, samples })
          drain(stream)
          reply(200, { text: textOf(stream) })
          return
        }
        request.resume()
        stream.inputFinished()
        drain(stream)
        const text = textOf(stream)
        streams.delete(id)
        reply(200, { text })
      } catch (error) {
        reply(error instanceof ChunkError ? 400 : 500, {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof ChunkError ? { code: 'invalid-input' } : {}),
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
  // The Host passes the configuration inline; a path is accepted so a shell
  // without safe argument quoting can run the same process for diagnostics.
  const argument = process.argv[2]
  if (typeof argument !== 'string' || argument === '') throw new Error('Missing worker configuration')
  const raw = argument.startsWith('{') ? JSON.parse(argument) : JSON.parse(readFileSync(argument, 'utf8'))
  const token = process.env.DSH_DICTADO_TOKEN
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('DSH_DICTADO_TOKEN is missing or invalid')
  delete process.env.DSH_DICTADO_TOKEN
  const { port } = await startServer(token, raw.config, raw.paths)
  process.stdout.write(`${JSON.stringify({ port })}\n`)
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    // Exit once the message is flushed: the loaded native model would otherwise keep the process alive.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => { process.exit(1) })
  })
}

export { collapseStreamingRepeats, decodePcm }
