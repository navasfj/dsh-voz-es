/**
 * Private synthesis process for the read-aloud plugin.
 *
 * The Host passes one JSON object in `argv[2]` with the verified model paths
 * and inference settings, and the bearer secret in `DSH_TTS_TOKEN`, which is
 * removed from the environment once read. After loading the native Piper model
 * the process binds an ephemeral loopback listener and writes `{"port":N}` as
 * its only stdout output. A failure before readiness writes only its message to
 * stderr and exits with code 1.
 */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const MAX_BODY_BYTES = 16 * 1024

/**
 * Resolve sherpa-onnx from the DSH installation, since a linked profile bundle
 * does not reach the packaged native runtime through ordinary resolution.
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
 * Encode mono float samples as a canonical 16-bit PCM WAV.
 * @param samples - normalized samples.
 * @param sampleRate - source rate.
 * @returns complete WAV bytes.
 */
function encodeWav(samples, sampleRate) {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples.length * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-32768, Math.min(32767, Math.round(samples[index] * 32768)))
    buffer.writeInt16LE(value, 44 + index * 2)
  }
  return buffer
}

/**
 * Read one bounded JSON request body.
 * @param request - incoming request.
 * @returns parsed text, or undefined when the body is invalid or too large.
 */
function readText(request) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(undefined)
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim() : undefined)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

async function main() {
  const config = JSON.parse(process.argv[2])
  const token = process.env.DSH_TTS_TOKEN
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('DSH_TTS_TOKEN is missing or invalid')
  delete process.env.DSH_TTS_TOKEN
  const sherpa = loadSherpa()
  const tts = new sherpa.OfflineTts({
    model: {
      vits: { model: config.model, tokens: config.tokens, dataDir: config.dataDir },
    },
    numThreads: config.threads,
    provider: 'cpu',
  })
  const expected = Buffer.from(`Bearer ${token}`)
  const server = createServer((request, response) => {
    const reply = (status, value, contentType = 'application/json') => {
      response.writeHead(status, { 'content-type': contentType }).end(value)
    }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      request.resume()
      reply(401, JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'POST' || url.pathname !== '/synthesize') {
      request.resume()
      reply(404, JSON.stringify({ error: 'Unknown endpoint' }))
      return
    }
    void (async () => {
      const text = await readText(request)
      if (text === undefined) {
        reply(400, JSON.stringify({ error: 'text required' }), 'application/json')
        return
      }
      try {
        // Electron's V8 memory cage rejects native external buffers.
        const audio = tts.generate({ text, sid: 0, speed: config.speed, enableExternalBuffer: false })
        reply(200, encodeWav(audio.samples, audio.sampleRate), 'audio/wav')
      } catch (error) {
        reply(500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), 'application/json')
      }
    })()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => { process.exit(1) })
})
