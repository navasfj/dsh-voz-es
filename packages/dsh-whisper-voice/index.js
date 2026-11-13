/**
 * Local Whisper provider for the DSH voice-input microphone.
 *
 * The plugin registers one `SpeechProvider` on the shared `speechToText`
 * registry. It owns model preparation (a verified download of revision-pinned
 * ONNX weights), a managed recognition process, and one bounded transcription
 * queue. Recordings never become Session events: only the user's later
 * submission writes the recognized text.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const name = 'speech-to-text-whisper'
export const inject = ['speechToText', 'subprocess']

/** Platforms whose packaged sherpa-onnx runtime the provider supports. */
const SUPPORTED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']

/**
 * Language hints offered by the UI. `auto` leaves Whisper's language
 * detection enabled; `es` pins Spanish so an accent is not read as another
 * language.
 */
const LANGUAGES = ['auto', 'es', 'en', 'pt', 'ca', 'gl', 'eu', 'fr', 'de', 'it', 'nl', 'ru', 'uk', 'pl', 'tr', 'ar', 'hi', 'ja', 'ko', 'zh', 'sv', 'no', 'da', 'fi']

/** Verified model files, keyed by model size. */
const LOCK = JSON.parse(readFileSync(new URL('./runtime/assets.json', import.meta.url), 'utf8'))

/** Deployment defaults; every value is replaceable through the profile patch. */
const DEFAULTS = {
  providerId: 'whisper-local',
  model: 'base',
  language: 'es',
  threads: 2,
  maxAudioBytes: 4 * 1024 * 1024,
  prepareTimeoutMs: 3_600_000,
  inferenceTimeoutMs: 120_000,
  idleTimeoutMs: 300_000,
  maxPending: 4,
  graceMs: 1000,
  maxLogBytes: 64 * 1024,
  maxResponseBytes: 128 * 1024,
  progressIntervalMs: 100,
  autoPrepare: true,
}

/** Invalid recording data, reported to the caller as a marked input rejection. */
class SpeechInputError extends Error {}

/** A classified download failure carrying safe diagnostics for the UI. */
class SpeechDownloadError extends Error {
  constructor(download, options) {
    super(`Speech download failed: ${download.resource} (${download.reason})`, options)
    this.download = download
  }
}

/**
 * Resolve the provider-owned model cache root.
 *
 * A deployment may set `dataRoot` explicitly. Otherwise the plugin asks the
 * Host's `dshHomePath` helper, then `DSH_HOME`, then the platform home. Doing
 * this in code keeps the bundle patch free of `!!js` expressions, which are
 * evaluated against a context this row may not share.
 *
 * @param ctx - Host context that may carry the home-path helper.
 * @param value - validated row configuration.
 * @returns an absolute cache directory.
 */
function resolveDataRoot(ctx, value) {
  if (typeof value.dataRoot === 'string' && value.dataRoot !== '') {
    if (!isAbsolute(value.dataRoot)) throw new Error(`dataRoot must be absolute: ${value.dataRoot}`)
    return value.dataRoot
  }
  const helper = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
  if (typeof helper === 'function') {
    try {
      return helper('speech-to-text', 'whisper')
    } catch {
      // Fall through to the environment.
    }
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'speech-to-text', 'whisper')
  return join(homedir(), '.dsh', 'speech-to-text', 'whisper')
}

/**
 * Read and validate the row configuration.
 * @param ctx - Host context that may carry the home-path helper.
 * @param raw - the Loader-supplied `config` object.
 * @returns complete settings with defaults applied.
 */
function normalizeConfig(ctx, raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) if (value[key] !== undefined) config[key] = value[key]
  config.dataRoot = resolveDataRoot(ctx, value)
  if (typeof config.dataRoot !== 'string' || config.dataRoot === '') throw new Error('dataRoot is required')
  if (!isAbsolute(config.dataRoot)) throw new Error(`dataRoot must be absolute: ${config.dataRoot}`)
  if (config.modelDirectory !== undefined) {
    if (typeof config.modelDirectory !== 'string' || !isAbsolute(config.modelDirectory)) {
      throw new Error(`modelDirectory must be an absolute path: ${config.modelDirectory}`)
    }
  }
  if (typeof config.providerId !== 'string' || config.providerId === '') throw new Error('providerId is required')
  if (!Object.hasOwn(LOCK.models, config.model)) throw new Error(`Unknown Whisper model: ${config.model}`)
  if (!LANGUAGES.includes(config.language)) throw new Error(`Unsupported language: ${config.language}`)
  const platform = `${process.platform}-${process.arch}`
  if (!SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`Local Whisper is unavailable for ${platform}`)
  for (const key of ['threads', 'maxAudioBytes', 'prepareTimeoutMs', 'inferenceTimeoutMs', 'idleTimeoutMs', 'maxPending', 'graceMs', 'maxLogBytes', 'maxResponseBytes', 'progressIntervalMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`)
  }
  return config
}

/**
 * Resolve the model files of the configured size.
 * @param config - complete settings.
 * @returns download root, verified asset set, and prepared paths.
 */
function resolveModel(config) {
  const model = LOCK.models[config.model]
  const root = config.modelDirectory ?? join(config.dataRoot, 'models', `whisper-${config.model}`)
  return {
    model,
    root,
    assets: [model.encoder, model.decoder, model.tokens],
    managed: config.modelDirectory === undefined,
    paths: {
      encoder: join(root, model.encoder.name),
      decoder: join(root, model.decoder.name),
      tokens: join(root, model.tokens.name),
      worker: fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)),
    },
  }
}

/**
 * Compare one file with its pinned identity.
 * @param path - candidate file.
 * @param asset - pinned name, size and hash.
 * @param signal - cancellation.
 * @returns whether the file is a byte-exact copy.
 */
async function matchesAsset(path, asset, signal) {
  signal.throwIfAborted()
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`Speech asset is not a regular file: ${path}`)
    if (info.size !== asset.bytes) return false
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) digest.update(chunk)
    return digest.digest('hex') === asset.sha256
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

/**
 * Inspect existing model files without downloading or writing anything.
 * @param config - complete settings.
 * @param signal - cancellation or inspection deadline.
 * @returns prepared paths, or undefined when a managed file is missing or corrupted.
 */
async function inspectModel(config, signal) {
  const { assets, managed, paths } = resolveModel(config)
  signal.throwIfAborted()
  try {
    await Promise.all([paths.encoder, paths.decoder, paths.tokens].map((path) => access(path)))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
  if (!managed) return paths
  for (const asset of assets) {
    if (!await matchesAsset(join(resolveModel(config).root, asset.name), asset, signal)) return undefined
  }
  signal.throwIfAborted()
  return paths
}

/**
 * Map a low-level transfer error onto the UI's diagnostic vocabulary.
 * @param error - thrown transfer error.
 * @returns safe reason code.
 */
function classifyFailure(error) {
  const code = error?.cause?.code ?? error?.code
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout'
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'certificate'
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM') return 'storage'
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ECONNREFUSED') return 'network'
  return 'unknown'
}

/**
 * Download one pinned file into a unique partial file, verify it, then publish it atomically.
 * @param asset - pinned release identity.
 * @param root - provider-owned cache directory.
 * @param signal - preparation cancellation.
 * @param report - Host-owned progress publisher.
 * @returns verified local file path.
 */
async function downloadAsset(asset, root, signal, report) {
  signal.throwIfAborted()
  const destination = join(root, asset.name)
  const partial = `${destination}.${randomUUID()}.part`
  let source = new URL(asset.url).origin
  try {
    await mkdir(root, { recursive: true })
    if (await matchesAsset(destination, asset, signal)) return destination
    try {
      const response = await fetch(asset.url, { signal })
      source = new URL(response.url || asset.url).origin
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new SpeechDownloadError({ resource: asset.name, source, reason: 'http', status: response.status })
      }
      const digest = createHash('sha256')
      let completedBytes = 0
      const publish = () => { report({ phase: 'downloading', resource: asset.name, completedBytes, totalBytes: asset.bytes }) }
      publish()
      const hashing = new Transform({
        transform(chunk, _encoding, callback) {
          completedBytes += chunk.length
          if (completedBytes > asset.bytes) {
            callback(new SpeechDownloadError({ resource: asset.name, source, reason: 'integrity' }))
            return
          }
          digest.update(chunk)
          publish()
          callback(null, chunk)
        },
      })
      await pipeline(response.body, hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
      if (completedBytes !== asset.bytes || digest.digest('hex') !== asset.sha256) {
        throw new SpeechDownloadError({ resource: asset.name, source, reason: 'integrity' })
      }
      signal.throwIfAborted()
      await rename(partial, destination)
      return destination
    } finally {
      await rm(partial, { force: true })
    }
  } catch (error) {
    if (signal.aborted || error instanceof SpeechDownloadError) throw error
    throw new SpeechDownloadError({ resource: asset.name, source, reason: classifyFailure(error) }, { cause: error })
  }
}

/**
 * Download and verify every managed model file.
 * @param config - complete settings.
 * @param signal - preparation cancellation or deadline.
 * @param report - Host-owned progress publisher.
 * @returns prepared paths.
 */
async function prepareModel(config, signal, report) {
  const { assets, managed, root, paths } = resolveModel(config)
  if (managed) {
    report({ phase: 'checking', step: 'model', startedAt: Date.now() })
    for (const asset of assets) await downloadAsset(asset, root, signal, (state) => { report({ ...state, step: 'model' }) })
  }
  report({ phase: 'checking', step: 'verify', startedAt: Date.now() })
  if (!await inspectModel(config, signal)) throw new Error('Whisper model verification failed: missing or corrupted files')
  return paths
}

/**
 * Wait for one cancellable operation without losing ownership of its eventual settlement.
 * @param pending - operation to await.
 * @param signal - cancellation.
 * @returns the operation result.
 */
function waitFor(pending, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Speech operation cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/**
 * Read one bounded worker readiness frame and reject exit before readiness.
 * @param handle - newly spawned worker with piped stdout.
 * @param limit - maximum readiness bytes.
 * @param signal - startup deadline or caller cancellation.
 * @returns the dynamically allocated loopback port.
 */
async function readReady(handle, limit, signal) {
  if (!handle.stdout) throw new Error('Whisper worker stdout is unavailable')
  signal.throwIfAborted()
  const stdout = handle.stdout
  let text = ''
  const pending = Promise.withResolvers()
  const data = (chunk) => {
    text += chunk.toString('utf8')
    if (Buffer.byteLength(text) > limit) {
      pending.reject(new Error('Whisper worker readiness exceeded its byte limit'))
      return
    }
    const end = text.indexOf('\n')
    if (end < 0) return
    try {
      const value = JSON.parse(text.slice(0, end))
      if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('port out of range')
      pending.resolve(value.port)
    } catch (error) {
      pending.reject(new Error('Invalid Whisper worker readiness', { cause: error }))
    }
  }
  stdout.on('data', data)
  stdout.on('error', pending.reject)
  void handle.done.then(() => {
    pending.reject(new Error(`Whisper worker exited before readiness: ${handle.collected.stderr?.readFrom(0).text ?? ''}`))
  }, pending.reject)
  try {
    return await waitFor(pending.promise, signal)
  } finally {
    stdout.off('data', data)
    stdout.off('error', pending.reject)
    stdout.resume()
  }
}

/**
 * Decode one bounded worker HTTP response.
 * @param response - private authenticated worker response.
 * @param limit - maximum bytes retained before JSON parsing.
 * @returns the validated transcript.
 */
async function readTranscript(response, limit) {
  if (!response.body) throw new Error('Whisper worker returned no response')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new Error('Whisper transcript exceeded its byte limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!response.ok) {
    if ((response.status === 400 || response.status === 413) && value.code === 'invalid-input') throw new SpeechInputError(value.error)
    throw new Error(value.error)
  }
  if (typeof value.text !== 'string' || typeof value.audioSeconds !== 'number' || typeof value.inferenceSeconds !== 'number') {
    throw new Error('Invalid Whisper transcript response')
  }
  return { text: value.text, audioSeconds: value.audioSeconds, inferenceSeconds: value.inferenceSeconds }
}

/** One serial Whisper worker with request-owned cancellation and idle reclamation. */
class WhisperModel {
  #worker
  #tail = Promise.resolve()
  #pending = 0
  #lifetime = new AbortController()
  #idle
  #runtime
  #state
  #listeners = new Set()
  #lastProgressAt = 0
  #preparing

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.#state = { phase: 'unprepared', steps: ['check', 'model', 'verify', 'load'].map((kind) => ({ kind, status: 'pending' })) }
  }

  /** @returns the configured disk footprint of the selected model. */
  get diskBytes() {
    return resolveModel(this.config).assets.reduce((total, asset) => total + asset.bytes, 0)
  }

  /** @returns the current Host-owned preparation state. */
  snapshot() {
    return this.#state
  }

  /**
   * Observe readiness.
   * @param listener - invalidation callback.
   * @returns subscription disposer.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #publish(state) {
    if (this.#preparing !== undefined && ['ready', 'standby', 'unprepared', 'failed', 'cancelled'].includes(state.phase)) {
      this.#preparing.completed = true
    }
    const previous = this.#state
    const steps = state.steps ?? previous.steps.map((item) => {
      if (state.phase === 'ready') return { ...item, status: 'complete' }
      if (state.step === 'check' && item.kind !== 'check') return { kind: item.kind, status: 'pending' }
      if (state.step === item.kind) return item.status === 'running' ? item : { kind: item.kind, status: 'running', startedAt: Date.now() }
      if (item.status !== 'running') return item
      if (state.phase === 'standby') return { ...item, status: 'cancelled' }
      if (state.phase === 'failed' || state.phase === 'cancelled') return { ...item, status: state.phase }
      return state.step === undefined ? item : { ...item, status: 'complete' }
    })
    this.#state = { ...state, steps }
    const now = performance.now()
    if (state.phase === 'downloading' && previous.phase === 'downloading' && state.resource === previous.resource
      && state.completedBytes !== state.totalBytes && now - this.#lastProgressAt < this.config.progressIntervalMs) return
    this.#lastProgressAt = now
    for (const listener of this.#listeners) listener()
  }

  /**
   * Inspect disk caches on activation. Missing managed files start one automatic
   * download so the first recording finds verified resources; the model itself is
   * loaded only when a recording arrives.
   */
  inspect() {
    this.#runPreparation(async (signal) => {
      const inspection = AbortSignal.any([signal, AbortSignal.timeout(this.config.prepareTimeoutMs)])
      this.#publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
      const cached = await inspectModel(this.config, inspection)
      inspection.throwIfAborted()
      if (cached !== undefined) {
        this.#runtime = cached
        this.#publish({ phase: 'standby', steps: this.#state.steps.map(({ kind }) => ({ kind, status: kind === 'load' ? 'pending' : 'complete' })) })
        return
      }
      this.#publish({ phase: 'unprepared', steps: this.#state.steps.map(({ kind }) => ({ kind, status: kind === 'check' ? 'complete' : 'pending' })) })
      if (!this.config.autoPrepare) return
      const runtime = await prepareModel(this.config, inspection, (state) => { this.#publish(state) })
      inspection.throwIfAborted()
      this.#runtime = runtime
      this.#publish({ phase: 'standby', steps: this.#state.steps.map(({ kind }) => ({ kind, status: kind === 'load' ? 'pending' : 'complete' })) })
    })
  }

  /**
   * Start or join one Host-owned preparation task.
   */
  prepare() {
    this.#runPreparation(async (signal) => {
      const setup = AbortSignal.any([signal, AbortSignal.timeout(this.config.prepareTimeoutMs)])
      if (this.#runtime !== undefined) {
        this.#publish({ phase: 'standby' })
        return
      }
      const runtime = await prepareModel(this.config, setup, (state) => { this.#publish(state) })
      setup.throwIfAborted()
      this.#runtime = runtime
      this.#publish({ phase: 'standby' })
    })
  }

  #runPreparation(run) {
    if (this.#preparing !== undefined || this.#worker !== undefined) return
    this.#lifetime.signal.throwIfAborted()
    const abort = new AbortController()
    const task = { abort, settled: Promise.resolve(), completed: false }
    this.#preparing = task
    task.settled = this.#enqueue(run, abort.signal)
      .catch((error) => {
        if (this.#lifetime.signal.aborted) return
        this.#publish(abort.signal.aborted
          ? { phase: 'cancelled' }
          : { phase: 'failed', message: error instanceof Error ? error.message : String(error), ...error instanceof SpeechDownloadError ? { download: error.download } : {} })
      })
      .finally(() => { this.#preparing = undefined })
  }

  /** Cancel unfinished preparation; completed readiness is retained. */
  async cancel() {
    const task = this.#preparing
    if (task === undefined) return
    if (!task.completed) {
      this.#publish({ phase: 'cancelling', startedAt: Date.now() })
      task.abort.abort(new Error('Whisper preparation cancelled'))
    }
    await task.settled
  }

  /**
   * Queue one bounded recording.
   * @param input - complete WAV and language hint.
   * @param signal - caller cancellation.
   * @returns recognized text.
   */
  async transcribe(input, signal) {
    return await this.#enqueue(async (combined) => await this.#execute(input, combined), signal)
  }

  async #enqueue(run, signal) {
    const combined = AbortSignal.any([signal, this.#lifetime.signal])
    combined.throwIfAborted()
    if (this.#pending >= this.config.maxPending) throw new Error('Speech transcription queue is full')
    clearTimeout(this.#idle)
    this.#pending++
    const job = this.#tail.then(async () => {
      combined.throwIfAborted()
      return await run(combined)
    })
    this.#tail = job.then(() => undefined, () => undefined).finally(() => {
      this.#pending--
      if (this.#pending === 0 && !this.#lifetime.signal.aborted && this.config.idleTimeoutMs > 0) {
        this.#idle = setTimeout(() => {
          this.#tail = this.#tail.then(async () => { await this.#stop() })
          void this.#tail.catch((error) => { this.ctx.logger.warn('Whisper worker idle cleanup failed', error) })
        }, this.config.idleTimeoutMs)
      }
    })
    return await job
  }

  async #start(signal) {
    if (this.#worker?.closed) await this.#stop()
    if (this.#worker !== undefined) return this.#worker
    const setup = AbortSignal.any([signal, AbortSignal.timeout(this.config.prepareTimeoutMs)])
    const cached = this.#runtime !== undefined
    if (!cached) this.#publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
    const runtime = this.#runtime ?? await prepareModel(this.config, setup, (state) => { this.#publish(state) })
    this.#runtime = runtime
    setup.throwIfAborted()
    this.#publish({ phase: cached ? 'waking' : 'loading', step: 'load', startedAt: Date.now() })
    await mkdir(this.config.dataRoot, { recursive: true })
    const token = randomBytes(32).toString('hex')
    const handle = this.ctx.subprocess.spawn({
      argv: [process.execPath, runtime.worker, JSON.stringify({
        config: { language: this.config.language, threads: this.config.threads, maxAudioBytes: this.config.maxAudioBytes },
        paths: { encoder: runtime.encoder, decoder: runtime.decoder, tokens: runtime.tokens },
      })],
      cwd: this.config.dataRoot,
      graceMs: this.config.graceMs,
      env: { DSH_WHISPER_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: this.config.maxLogBytes } },
    })
    try {
      const port = await readReady(handle, this.config.maxLogBytes, setup)
      const worker = { handle, url: `http://127.0.0.1:${port}`, token, closed: false }
      this.#worker = worker
      this.#publish({ phase: 'ready' })
      const exited = () => {
        if (!worker.closed) {
          worker.closed = true
          this.#publish({ phase: 'standby' })
        }
      }
      void handle.done.then(exited, exited)
      return worker
    } catch (error) {
      handle.terminate()
      await handle.waitForExit()
      throw error
    }
  }

  async #execute(input, signal) {
    const phase = this.#state.phase
    if (phase !== 'ready' && phase !== 'standby' && phase !== 'waking') throw new Error('Prepare the local Whisper provider before recording')
    try {
      const worker = await this.#start(signal)
      const call = AbortSignal.any([signal, AbortSignal.timeout(this.config.inferenceTimeoutMs)])
      const response = await fetch(`${worker.url}/transcribe?language=${encodeURIComponent(input.language)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${worker.token}`, 'content-type': 'audio/wav' },
        body: Buffer.from(input.audio),
        signal: call,
      })
      const result = await readTranscript(response, this.config.maxResponseBytes).catch((error) => {
        call.throwIfAborted()
        throw error
      })
      call.throwIfAborted()
      return result
    } catch (error) {
      if (error instanceof SpeechInputError) throw error
      await this.#stop()
      this.#publish({ phase: 'standby' })
      throw error
    }
  }

  async #stop() {
    const worker = this.#worker
    if (worker === undefined) return
    worker.closed = true
    worker.handle.terminate()
    await worker.handle.waitForExit()
    this.#worker = undefined
    this.#publish({ phase: 'standby' })
  }

  /** Stop the recognizer and join every accepted recording. */
  async dispose() {
    this.#listeners.clear()
    this.#lifetime.abort(new Error('Whisper provider disposed'))
    clearTimeout(this.#idle)
    try {
      await this.#tail
    } finally {
      await this.#stop()
    }
    await this.#preparing?.settled
  }
}

/**
 * Register the local Whisper recognizer.
 * @param ctx - Host registry and subprocess owner.
 * @param rawConfig - the Loader-supplied row configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(ctx, rawConfig)
  const model = new WhisperModel(ctx, config)
  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: config.providerId,
        name: `Whisper ${config.model} (INT8)`,
        location: 'host-local',
        languages: LANGUAGES,
        setupEstimate: {
          recommendedDiskBytes: model.diskBytes,
          expectedMemoryBytes: model.diskBytes * 2,
          minimumMinutes: 1,
          maximumMinutes: 10,
        },
      },
      preparation: model,
      transcribe: async (input, signal) => await model.transcribe(input, signal),
    })
    model.inspect()
    // If the profile still names a recognizer that is not registered (for
    // example a provider this bundle disabled), the microphone would have no
    // usable target. Repair that dead selection once; a valid user choice is
    // never overwritten.
    const current = ctx.speechToText.snapshot()
    if (!ctx.speechToText.listProviders().some((item) => item.id === current.selection.providerId)) {
      void ctx.speechToText.configure({ providerId: config.providerId, language: config.language })
        .catch((error) => { ctx.logger.warn('Whisper voice selection could not be repaired', error) })
    }
    return async () => {
      const removing = unregister()
      await model.dispose()
      await removing
    }
  })
}
