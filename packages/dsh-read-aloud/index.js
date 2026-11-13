/**
 * Host side of the read-aloud plugin.
 *
 * The browser's `speechSynthesis` only reaches the old SAPI voices, which sound
 * canned. This route synthesizes each reply with a local Piper model through
 * sherpa-onnx and returns a WAV the page plays with a real audio element:
 * natural voice, true pause/resume, and no network service.
 *
 * The model is downloaded once from a pinned revision, verified by size and
 * SHA-256, and inference runs in a managed child process so the Host event loop
 * never blocks while a reply is synthesized.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer', 'connection', 'subprocess']

/** Exact route the page posts text to. */
const ROUTE = '/read-aloud/tts'
/** Request bodies are one short reply; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024
/** One synthesis call never reads more than this. */
const MAX_TEXT = 4000
/** Ceiling for one WAV response (a few minutes of 22 kHz mono audio). */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024
/** Stop the inference process after this much inactivity; the model stays on disk. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

const ASSETS = JSON.parse(readFileSync(new URL('./runtime/assets.json', import.meta.url), 'utf8'))
const WORKER = fileURLToPath(new URL('./tts-worker.js', import.meta.url))

/** Default speaking rate: a touch slower than Piper's natural pace. */
const DEFAULT_SPEED = 0.9

/**
 * Read and validate the row configuration.
 * @param raw - the Loader-supplied `config` object.
 * @returns speaking rate and CPU thread count.
 */
function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const speed = typeof value.speed === 'number' && value.speed >= 0.5 && value.speed <= 2 ? value.speed : DEFAULT_SPEED
  const threads = Number.isSafeInteger(value.threads) && value.threads > 0 ? value.threads : 4
  return { speed, threads }
}

/**
 * Resolve the plugin cache root under the DSH home.
 * @param ctx - Host context that may carry the home-path helper.
 * @returns absolute directory for this plugin's data.
 */
function resolveHome(ctx) {
  const helper = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
  if (typeof helper === 'function') {
    try {
      return helper('read-aloud')
    } catch {
      // Fall through to the environment.
    }
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'read-aloud')
  return join(homedir(), '.dsh', 'read-aloud')
}

/**
 * Compare one file with its pinned size and digest.
 * @param path - candidate file.
 * @param asset - pinned asset.
 * @returns whether the file is a byte-exact copy.
 */
async function matches(path, asset) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== asset.bytes) return false
    return createHash('sha256').update(readFileSync(path)).digest('hex') === asset.sha256
  } catch {
    return false
  }
}

/**
 * Download and verify every model file once.
 * @param root - model directory.
 * @param logger - Host logger for progress and failures.
 * @returns completion after all assets are verified.
 */
async function prepareModel(root, logger) {
  await mkdir(root, { recursive: true })
  for (const asset of ASSETS.assets) {
    const target = join(root, asset.name)
    if (await matches(target, asset)) continue
    logger.info(`read-aloud: downloading ${asset.name} (${asset.bytes} bytes)`)
    const response = await fetch(asset.url)
    if (!response.ok) throw new Error(`download failed for ${asset.name}: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== asset.bytes) throw new Error(`download size mismatch for ${asset.name}`)
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new Error(`download integrity mismatch for ${asset.name}`)
    }
    await mkdir(dirname(target), { recursive: true })
    const partial = `${target}.part`
    await writeFile(partial, bytes)
    await rename(partial, target)
  }
}

/**
 * Wait for one bounded worker readiness frame.
 * @param handle - freshly spawned worker with piped stdout.
 * @param limit - maximum readiness bytes.
 * @returns the loopback port.
 */
async function readReady(handle, limit) {
  if (!handle.stdout) throw new Error('synthesis worker stdout is unavailable')
  const stdout = handle.stdout
  let text = ''
  const pending = Promise.withResolvers()
  const data = (chunk) => {
    text += chunk.toString('utf8')
    if (Buffer.byteLength(text) > limit) {
      pending.reject(new Error('synthesis worker readiness exceeded its byte limit'))
      return
    }
    const end = text.indexOf('\n')
    if (end < 0) return
    try {
      const value = JSON.parse(text.slice(0, end))
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('port out of range')
      pending.resolve(value.port)
    } catch (error) {
      pending.reject(new Error('invalid synthesis worker readiness', { cause: error }))
    }
  }
  stdout.on('data', data)
  stdout.on('error', pending.reject)
  void handle.done.then(() => {
    pending.reject(new Error(`synthesis worker exited before readiness: ${handle.collected.stderr?.readFrom(0).text ?? ''}`))
  }, pending.reject)
  try {
    return await pending.promise
  } finally {
    stdout.off('data', data)
    stdout.off('error', pending.reject)
    stdout.resume()
  }
}

/** One managed Piper process with idle reclamation. */
class Synthesizer {
  #worker
  #idle
  #disposed = false

  constructor(ctx, config, paths) {
    this.ctx = ctx
    this.config = config
    this.paths = paths
  }

  /**
   * Synthesize one text chunk.
   * @param text - plain text already capped by the route.
   * @returns WAV bytes.
   */
  async synthesize(text) {
    const worker = await this.#ensure()
    clearTimeout(this.#idle)
    const response = await fetch(`${worker.url}/synthesize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) throw new Error(`synthesis worker returned ${response.status}`)
    const wav = Buffer.from(await response.arrayBuffer())
    if (wav.length < 44 || wav.length > MAX_RESPONSE_BYTES) throw new Error('synthesis worker returned invalid audio')
    this.#idle = setTimeout(() => {
      this.#idle = undefined
      void this.#stop().catch((error) => { this.ctx.logger.warn('read-aloud: idle stop failed', error) })
    }, IDLE_TIMEOUT_MS)
    return wav
  }

  async #ensure() {
    if (this.#disposed) throw new Error('speech synthesis was disposed')
    if (this.#worker !== undefined && !this.#worker.closed) return this.#worker
    if (this.#worker !== undefined) await this.#stop()
    const token = randomBytes(32).toString('hex')
    const handle = this.ctx.subprocess.spawn({
      argv: [process.execPath, WORKER, JSON.stringify({
        model: this.paths.model,
        tokens: this.paths.tokens,
        dataDir: this.paths.dataDir,
        threads: this.config.threads,
        speed: this.config.speed,
      })],
      cwd: this.paths.root,
      graceMs: 1000,
      env: { DSH_TTS_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
    })
    try {
      const port = await readReady(handle, 64 * 1024)
      const worker = { handle, url: `http://127.0.0.1:${port}`, token, closed: false }
      this.#worker = worker
      const exited = () => { worker.closed = true }
      void handle.done.then(exited, exited)
      return worker
    } catch (error) {
      handle.terminate()
      await handle.waitForExit()
      throw error
    }
  }

  async #stop() {
    const worker = this.#worker
    if (worker === undefined) return
    this.#worker = undefined
    worker.closed = true
    worker.handle.terminate()
    await worker.handle.waitForExit()
  }

  /** Stop the inference process; prepared files stay on disk. */
  async dispose() {
    this.#disposed = true
    clearTimeout(this.#idle)
    this.#idle = undefined
    await this.#stop()
  }
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param req - incoming request.
 * @returns the body, or null past the byte ceiling.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Register the authenticated synthesis route.
 * @param ctx - Host context owning the web carrier and connection fence.
 * @param rawConfig - the Loader-supplied row configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const root = join(resolveHome(ctx), 'models', 'piper-es-sharvard')
  const paths = {
    root,
    model: join(root, 'es_ES-sharvard-medium.onnx'),
    tokens: join(root, 'tokens.txt'),
    dataDir: join(root, 'espeak-ng-data'),
  }
  let prepared
  const ensureModel = () => {
    prepared ??= prepareModel(root, ctx.logger).catch((error) => {
      prepared = undefined
      throw error
    })
    return prepared
  }
  // Warm the cache at activation so the first reply does not wait for 77 MB.
  void ensureModel().catch((error) => { ctx.logger.warn('read-aloud: model preparation failed', error) })

  const synthesizer = new Synthesizer(ctx, config, paths)
  ctx.effect(() => async () => { await synthesizer.dispose() }, 'read-aloud: synthesis worker')
  let tail = Promise.resolve()
  const serialized = (task) => {
    const run = tail.then(task, task)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/read-aloud/ping',
    handler: (req, res) => {
      if (rejected(req, res)) return
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, engine: 'piper', speed: config.speed }))
    },
  }), 'read-aloud: GET /read-aloud/ping')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const body = await readBody(req).catch(() => null)
      if (body === null) {
        res.statusCode = 413
        res.end()
        return
      }
      let text
      try {
        text = JSON.parse(body).text
      } catch {
        text = undefined
      }
      if (typeof text !== 'string' || text.trim() === '') {
        res.statusCode = 400
        res.end('text required')
        return
      }
      try {
        await ensureModel()
        const wav = await serialized(() => synthesizer.synthesize(text.trim().slice(0, MAX_TEXT)))
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': wav.length,
          'cache-control': 'no-store',
        })
        res.end(wav)
      } catch (error) {
        ctx.logger.warn('read-aloud: speech synthesis failed', error)
        res.statusCode = 500
        res.end('speech synthesis failed')
      }
    },
  }), `read-aloud: POST ${ROUTE}`)
}
