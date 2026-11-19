/**
 * Host side of the live dictation plugin.
 *
 * While the user speaks, a Kroko streaming model decodes chunks of PCM and the
 * page paints the growing text in the composer. When the recording stops, the
 * same audio goes through the configured Whisper provider, which rewrites the
 * provisional text with the final one. Two models, each doing what it is good
 * at: speed for the live preview, accuracy for what stays written.
 *
 * The streaming model is downloaded once from a pinned revision, verified by
 * size and SHA-256, and decoded in a managed child process so the Host event
 * loop never blocks.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, readFileSync, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer', 'connection', 'subprocess']

const ROUTE = '/dictado-vivo'
const LOCK = JSON.parse(readFileSync(new URL('./runtime/assets.json', import.meta.url), 'utf8'))
const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url))
const SUPPORTED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

const DEFAULTS = {
  model: 'kroko-es',
  language: 'es',
  threads: 4,
  maxChunkBytes: 64 * 1024,
  maxAudioBytes: 8 * 1024 * 1024,
  maxStreams: 2,
  prepareTimeoutMs: 1_800_000,
  inferenceTimeoutMs: 30_000,
  // Half an hour keeps the engine warm between dictations: a cold start would
  // otherwise be paid every time the microphone has been idle for five minutes.
  idleTimeoutMs: 1_800_000,
  graceMs: 1000,
  autoPrepare: true,
  preload: true,
  // Keeping the last recording on disk is what makes an A/B between engines
  // possible later; it never leaves this machine.
  keepAudio: true,
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
      return helper('dictado-vivo')
    } catch {
      // Fall through to the environment.
    }
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'dictado-vivo')
  return join(homedir(), '.dsh', 'dictado-vivo')
}

/**
 * Read and validate the row configuration.
 * @param ctx - Host context.
 * @param raw - the Loader-supplied `config` object.
 * @returns complete settings.
 */
function normalizeConfig(ctx, raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) if (value[key] !== undefined) config[key] = value[key]
  config.dataRoot = resolveHome(ctx)
  if (!isAbsolute(config.dataRoot)) throw new Error(`dataRoot must be absolute: ${config.dataRoot}`)
  if (!Object.hasOwn(LOCK.models, config.model)) throw new Error(`Unknown live model: ${config.model}`)
  if (typeof config.language !== 'string' || config.language === '') throw new Error('language is required')
  for (const key of ['threads', 'maxChunkBytes', 'maxAudioBytes', 'maxStreams', 'prepareTimeoutMs', 'inferenceTimeoutMs', 'idleTimeoutMs', 'graceMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`)
  }
  if (!SUPPORTED_PLATFORMS.includes(`${process.platform}-${process.arch}`)) throw new Error(`Live dictation is unavailable for ${process.platform}-${process.arch}`)
  return config
}

/**
 * Resolve the model files of the configured model.
 * @param config - complete settings.
 * @returns download root, asset list and prepared paths.
 */
function resolveModel(config) {
  const model = LOCK.models[config.model]
  const root = join(config.dataRoot, 'models', config.model)
  const assets = { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner, tokens: model.tokens }
  const paths = Object.fromEntries(Object.entries(assets).map(([role, asset]) => [role, join(root, asset.name)]))
  return { assets, root, paths }
}

/**
 * Compare one file with its pinned identity.
 * @param path - candidate file.
 * @param asset - pinned name, size and hash.
 * @returns whether the file is a byte-exact copy.
 */
async function matchesAsset(path, asset) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== asset.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path)) digest.update(chunk)
    return digest.digest('hex') === asset.sha256
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

/**
 * Download one pinned file into a unique partial file, verify it, then publish it.
 * @param asset - pinned release identity.
 * @param root - plugin-owned cache directory.
 * @param report - progress callback.
 * @returns verified local path.
 */
async function downloadAsset(asset, root, report) {
  const destination = join(root, asset.name)
  if (await matchesAsset(destination, asset)) return destination
  await mkdir(root, { recursive: true })
  const partial = `${destination}.${randomBytes(8).toString('hex')}.part`
  try {
    const response = await fetch(asset.url)
    if (!response.ok || !response.body) throw new Error(`${asset.name}: HTTP ${response.status}`)
    const digest = createHash('sha256')
    let completedBytes = 0
    report({ resource: asset.name, completedBytes, totalBytes: asset.bytes })
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        completedBytes += chunk.length
        if (completedBytes > asset.bytes) {
          callback(new Error(`${asset.name}: download exceeded its declared size`))
          return
        }
        digest.update(chunk)
        report({ resource: asset.name, completedBytes, totalBytes: asset.bytes })
        callback(null, chunk)
      },
    })
    await pipeline(response.body, hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
    if (completedBytes !== asset.bytes || digest.digest('hex') !== asset.sha256) throw new Error(`${asset.name}: integrity check failed`)
    await rename(partial, destination)
    return destination
  } finally {
    await rm(partial, { force: true })
  }
}

/** Health of the streaming model: disk state plus one download at a time. */
class LiveModel {
  #state = { phase: 'unprepared' }
  #listeners = new Set()
  #running

  constructor(config, paths) {
    this.config = config
    this.paths = paths
    this.assets = resolveModel(config).assets
  }

  /** @returns the current readiness state. */
  snapshot() {
    return this.#state
  }

  #publish(state) {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }

  /**
   * Inspect the cache without downloading anything.
   * @returns whether every pinned file is already verified.
   */
  async inspect() {
    for (const [role, asset] of Object.entries(this.assets)) {
      if (!await matchesAsset(this.paths[role], asset)) return false
    }
    return true
  }

  /**
   * Start or join the one preparation task.
   * @returns the ready status.
   */
  prepare() {
    this.#running ??= this.#download().finally(() => { this.#running = undefined })
    return this.#running
  }

  async #download() {
    this.#publish({ phase: 'preparing', step: 'model' })
    try {
      const root = resolveModel(this.config).root
      for (const asset of Object.values(this.assets)) {
        await downloadAsset(asset, root, (progress) => { this.#publish({ phase: 'preparing', step: 'model', ...progress }) })
      }
      for (const [role, asset] of Object.entries(this.assets)) {
        if (!await matchesAsset(this.paths[role], asset)) {
          this.#publish({ phase: 'failed', message: `${role} is missing or corrupted` })
          return this.#state
        }
      }
      this.#publish({ phase: 'ready' })
    } catch (error) {
      this.#publish({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
    return this.#state
  }
}

/** One serialized streaming worker with request-owned cancellation and idle reclamation. */
class Worker {
  #handle
  #url
  #token
  #idle
  #paths
  #lifetime = new AbortController()

  constructor(ctx, config, paths) {
    this.ctx = ctx
    this.config = config
    this.#paths = paths
  }

  /** @returns whether the streaming engine is loaded right now. */
  get running() {
    return this.#handle !== undefined
  }

  /**
   * Send one request to the worker, starting it when needed.
   * @param path - worker path with query string.
   * @param body - request body.
   * @param options - content type and timeout.
   * @returns parsed JSON response.
   */
  async call(path, body, options = {}) {
    const url = await this.#start(options.signal)
    clearTimeout(this.#idle)
    const call = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.timeoutMs ?? this.config.inferenceTimeoutMs)])
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': options.contentType ?? 'application/octet-stream' },
      body,
      signal: call,
    })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value.error ?? `Live worker HTTP ${response.status}`)
    this.#scheduleIdle()
    return value
  }

  #scheduleIdle() {
    if (this.config.idleTimeoutMs <= 0) return
    this.#idle = setTimeout(() => { void this.stop() }, this.config.idleTimeoutMs)
  }

  async #start(signal) {
    if (this.#handle !== undefined && this.#url !== undefined) return this.#url
    const token = randomBytes(32).toString('hex')
    const handle = this.ctx.subprocess.spawn({
      argv: [process.execPath, WORKER, JSON.stringify({
        config: { threads: this.config.threads, maxChunkBytes: this.config.maxChunkBytes, maxStreams: this.config.maxStreams },
        paths: this.#paths,
      })],
      cwd: this.config.dataRoot,
      graceMs: this.config.graceMs,
      env: { DSH_DICTADO_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
    })
    const port = await this.#readReady(handle, signal)
    this.#handle = handle
    this.#token = token
    this.#url = `http://127.0.0.1:${port}`
    void handle.done.then(() => { this.#handle = undefined; this.#url = undefined }, () => { this.#handle = undefined; this.#url = undefined })
    this.#scheduleIdle()
    return this.#url
  }

  async #readReady(handle, signal) {
    if (!handle.stdout) throw new Error('Live worker stdout is unavailable')
    const stdout = handle.stdout
    const limit = 64 * 1024
    let text = ''
    const pending = Promise.withResolvers()
    const data = (chunk) => {
      text += chunk.toString('utf8')
      if (Buffer.byteLength(text) > limit) { pending.reject(new Error('Live worker readiness exceeded its byte limit')); return }
      const end = text.indexOf('\n')
      if (end < 0) return
      try {
        const value = JSON.parse(text.slice(0, end))
        if (!Number.isInteger(value.port)) throw new Error('port missing')
        pending.resolve(value.port)
      } catch (error) { pending.reject(new Error('Invalid live worker readiness', { cause: error })) }
    }
    stdout.on('data', data)
    void handle.done.then(() => {
      pending.reject(new Error(`Live worker exited before readiness: ${handle.collected.stderr?.readFrom(0).text ?? ''}`))
    }, pending.reject)
    try {
      return await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { reject(new Error('Live worker took too long to load the model')) }, this.config.prepareTimeoutMs)
        signal?.addEventListener('abort', () => { clearTimeout(deadline); reject(new Error('Live worker cancelled')) }, { once: true })
        pending.promise.then((value) => { clearTimeout(deadline); resolve(value) }, (error) => { clearTimeout(deadline); reject(error) })
      })
    } finally {
      stdout.off('data', data)
      stdout.resume()
    }
  }

  async stop() {
    clearTimeout(this.#idle)
    const handle = this.#handle
    this.#handle = undefined
    this.#url = undefined
    if (handle === undefined) return
    handle.terminate()
    await handle.waitForExit()
  }

  async dispose() {
    this.#lifetime.abort()
    await this.stop()
  }
}

/**
 * Read one request body with a byte ceiling.
 * @param req - Node request.
 * @param limit - maximum accepted bytes.
 * @returns the body, or null when it exceeds the limit.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) { resolve(null); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Measure the level of one recording.
 *
 * A quiet microphone is the most common reason a recognizer gets words wrong,
 * and it is invisible from the page: the waveform is relative to its own scale.
 * The peak and the RMS in dBFS say whether the capture is healthy.
 *
 * @param audio - complete WAV sent by the page.
 * @returns level figures, or null when the audio cannot be parsed.
 */
function analyzeWave(audio) {
  if (audio.length < 44) return null
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const tag = (offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let offset = 12
  let dataOffset = -1
  let dataSize = 0
  let sampleRate = 16000
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + size > view.byteLength) break
    if (id === 'fmt ') sampleRate = view.getUint32(body + 4, true)
    if (id === 'data') { dataOffset = body; dataSize = size; break }
    offset = body + size + (size % 2)
  }
  if (dataOffset < 0 || dataSize < 2) return null
  const samples = Math.min(dataSize, view.byteLength - dataOffset) >> 1
  let peak = 0
  let sumSquares = 0
  let clipping = 0
  let loud = 0
  for (let index = 0; index < samples; index++) {
    const value = view.getInt16(dataOffset + index * 2, true) / 32768
    const magnitude = Math.abs(value)
    if (magnitude > peak) peak = magnitude
    if (magnitude >= 0.999) clipping += 1
    if (magnitude > 0.01) loud += 1
    sumSquares += value * value
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples))
  const db = (value) => (value <= 0 ? -120 : Math.round(20 * Math.log10(value) * 10) / 10)
  return {
    seconds: Math.round((samples / sampleRate) * 100) / 100,
    sampleRate,
    peakDbfs: db(peak),
    rmsDbfs: db(rms),
    clippingPercent: Math.round((clipping / Math.max(1, samples)) * 10000) / 100,
    // Samples below -40 dBFS, i.e. the part of the recording most likely to be
    // heard as silence by the recognizer.
    quietPercent: Math.round(((samples - loud) / Math.max(1, samples)) * 10000) / 100,
  }
}

/**
 * Register the live dictation routes.
 * @param ctx - Host context owning the web carrier and the speech registry.
 * @param rawConfig - the Loader-supplied row configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(ctx, rawConfig)
  const { paths } = resolveModel(config)
  const model = new LiveModel(config, paths)
  const worker = new Worker(ctx, config, paths)
  ctx.effect(() => async () => { await worker.dispose() }, 'dictado-vivo: streaming worker')

  if (config.autoPrepare) {
    void model.inspect().then((ready) => {
      if (!ready) return model.prepare().catch(() => undefined)
      return undefined
    }).catch(() => undefined)
  }
  // Warming the streaming worker at startup means the first dictation already
  // has its engine: the microphone opens immediately either way, but the live
  // text no longer waits for a five second model load.
  if (config.preload) {
    void model.prepare()
      .then((state) => (state.phase === 'ready' ? worker.call('/ping', Buffer.alloc(0)).catch(() => undefined) : undefined))
      .catch(() => undefined)
  }

  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/status`,
    handler: (req, res) => {
      if (rejected(req, res)) return
      json(res, 200, { ...model.snapshot(), model: config.model, worker: worker.running })
    },
  }), `dictado-vivo: GET ${ROUTE}/status`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/last`,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      try {
        const text = await readFile(join(config.dataRoot, 'last-recording.json'), 'utf8')
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(text)
      } catch {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end('null')
      }
    },
  }), `dictado-vivo: GET ${ROUTE}/last`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/prepare`,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return }
      req.resume()
      void model.prepare()
      json(res, 202, model.snapshot())
    },
  }), `dictado-vivo: POST ${ROUTE}/prepare`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/open`,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
      req.resume()
      try {
        const state = await model.prepare()
        if (state.phase !== 'ready') { json(res, 409, state); return }
        const opened = await worker.call('/open', Buffer.alloc(0))
        json(res, 200, opened)
      } catch (error) {
        ctx.logger.warn('dictado-vivo: could not open a dictation', error)
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `dictado-vivo: POST ${ROUTE}/open`)

  for (const step of ['chunk', 'close']) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE}/${step}`,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('id') ?? ''
        if (!/^[0-9a-f-]{36}$/.test(id)) { req.resume(); json(res, 400, { error: 'id required' }); return }
        const body = step === 'chunk' ? await readBody(req, config.maxChunkBytes) : (req.resume(), Buffer.alloc(0))
        if (body === null) { json(res, 413, { error: 'chunk too large' }); return }
        try {
          const value = await worker.call(`/${step}?id=${encodeURIComponent(id)}`, body)
          json(res, 200, value)
        } catch (error) {
          json(res, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), `dictado-vivo: POST ${ROUTE}/${step}`)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/final`,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
      const body = await readBody(req, config.maxAudioBytes)
      if (body === null) { json(res, 413, { error: 'recording too large' }); return }
      const level = analyzeWave(body)
      if (config.keepAudio) {
        void mkdir(config.dataRoot, { recursive: true })
          .then(() => writeFile(join(config.dataRoot, 'last-recording.wav'), body))
          .catch(() => undefined)
      }
      // Keeping the transcript next to the level figures is what makes a
      // dictation test checkable: the reference text can be compared with what
      // the engines actually returned. Failures are recorded too, otherwise an
      // empty final pass is indistinguishable from an engine that heard nothing.
      const record = (text, extra = {}) => {
        void mkdir(config.dataRoot, { recursive: true })
          .then(() => writeFile(join(config.dataRoot, 'last-recording.json'), `${JSON.stringify({ at: new Date().toISOString(), ...level, text, ...extra }, null, 2)}\n`))
          .catch(() => undefined)
      }
      const speech = ctx.get('speechToText')
      if (speech === undefined) { record('', { failure: 'sin proveedor de voz' }); json(res, 200, { text: '', skipped: 'no-provider', level }); return }
      try {
        const spec = speech.resolve({ audio: body, language: config.language })
        const result = await speech.transcribe(spec, AbortSignal.timeout(config.inferenceTimeoutMs))
        const text = typeof result?.text === 'string' ? result.text : ''
        record(text, text === '' ? { failure: 'el proveedor devolvió texto vacío' } : {})
        json(res, 200, { text, level })
      } catch (error) {
        ctx.logger.warn('dictado-vivo: final transcription failed', error)
        const failure = error instanceof Error ? error.message : String(error)
        record('', { failure })
        json(res, 200, { text: '', failed: failure, level })
      }
    },
  }), `dictado-vivo: POST ${ROUTE}/final`)
}
