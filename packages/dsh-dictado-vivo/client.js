/**
 * Live dictation for the composer.
 *
 * Replaces the stock microphone row with one that writes while you speak: the
 * page captures 16 kHz PCM, posts it in 320 ms chunks, and paints the text the
 * streaming model has decoded so far at the caret. When the recording stops,
 * the same audio goes to the configured Whisper provider and the provisional
 * text is replaced by the final one.
 *
 * The draft is only ever touched through the public `inputActions` face of the
 * slot (`captureInsertion` / `insertText`), so the plugin never reaches into
 * another plugin's DOM.
 */
window.__ModuleLoader__.load({
  id: '@navasfj/dsh-dictado-vivo',
  factory(require) {
    const React = require('react')
    const { useEffect, useLayoutEffect, useRef, useState } = React
    const h = React.createElement

    // The stock row renders DSH primitives; reuse them when the loader exposes
    // them so both the button and its tooltip stay identical, and fall back to
    // equivalents with the same measurements when it does not.
    const primitives = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return null }
    })()
    const SharedTooltip = primitives === null ? null : primitives.Tooltip
    const SharedButton = primitives === null ? null : primitives.Button
    const SharedStateDot = primitives === null ? null : primitives.StateDot

    const ROUTE = '/dictado-vivo'
    // Only dictate: stopping leaves the streaming text untouched, so it can be
    // edited before sending. Set to true to re-enable the final pass (Parakeet).
    const CORRECT_AFTER_STOP = false
    // The sound-test page lives in the sidebar, like the session manager.
    const PANEL_ENABLED = true
    /** 160 ms of 16 kHz mono audio: short enough to feel live, long enough to decode well. */
    const FRAME_SAMPLES = 2560
    const MAX_SECONDS = 120
    const POLL_MS = 700

    const STYLE = `
.dsh-dv-trigger{width:28px;padding:0;flex:none}
.dsh-dv-anchor{display:inline-flex;flex:none}
.dsh-dv-row{display:flex;align-items:center;gap:12px;width:100%;min-width:0;min-height:34px}
.dsh-dv-round{width:32px;height:32px;padding:0;border:0;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-specific-selector,rgba(127,127,127,.12));color:inherit;cursor:pointer}
.dsh-dv-round:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.2))}
.dsh-dv-round:focus-visible{outline:2px solid var(--dsw-focus-ring-color,currentColor);outline-offset:2px}
.dsh-dv-round[disabled]{opacity:.35;cursor:default}
.dsh-dv-meter-wrap{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.dsh-dv-voice{display:block;flex:1;width:0;min-width:60px;height:75px;mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent);-webkit-mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent)}
.dsh-dv-message{display:flex;align-items:center;gap:8px;flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-dv-inline{flex:none}
.dsh-dv-tip{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);display:none;padding:4px 8px;border-radius:6px;background:#2b2f36;color:#fff;font-size:12px;line-height:16px;white-space:nowrap;pointer-events:none;z-index:20;box-shadow:0 6px 18px rgba(0,0,0,.28)}
.dsh-dv-anchor:hover .dsh-dv-tip,.dsh-dv-anchor:focus-within .dsh-dv-tip{display:block}
.dsh-dv-page{max-width:640px;margin:0 auto;padding:24px;display:grid;gap:16px;font-size:13px}
.dsh-dv-head{display:grid;gap:6px}
.dsh-dv-head h1{margin:0;font-size:18px;font-weight:600}
.dsh-dv-head p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98)}
.dsh-dv-head .dsh-dv-action{justify-self:start;margin-top:6px}
.dsh-dv-card{display:grid;gap:10px;padding:16px;border:0.5px solid var(--dsw-alias-border-l1,#3a3f46);border-radius:12px}
.dsh-dv-card h2{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#8a8f98);letter-spacing:.02em}
.dsh-dv-card p{margin:0}
.dsh-dv-quote{margin:0;max-height:96px;overflow:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#8a8f98)}
.dsh-dv-meter{position:relative;height:10px;border-radius:5px;overflow:hidden;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}
.dsh-dv-meter > span{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--dsw-alias-state-success-primary,#16a34a);transition:width .08s linear}
.dsh-dv-meter[data-level="low"] > span{background:var(--dsw-alias-state-warning-primary,#d97706)}
.dsh-dv-meter[data-level="high"] > span{background:var(--dsw-alias-state-error-primary,#dc2626)}
.dsh-dv-read{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);font-variant-numeric:tabular-nums}
.dsh-dv-rowline{display:flex;align-items:center;gap:8px}
.dsh-dv-rowline input[type="range"]{flex:1;accent-color:var(--dsw-alias-state-business-primary,#3b82f6)}
.dsh-dv-action{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:0.5px solid var(--dsw-alias-border-l1,#3a3f46);border-radius:8px;background:transparent;color:inherit;font-size:12px;cursor:pointer}
.dsh-dv-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsh-dv-action:disabled{opacity:.5;cursor:default}
.dsh-dv-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6b7280)}
`

    /** Microphone outline at the stock optically-corrected weight. */
    function MicrophoneGlyph({ size = 18 }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
        h('path', { d: 'M5 11a7 7 0 0 0 14 0' }),
        h('path', { d: 'M12 18v3' }))
    }

    const StopGlyph = () => h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'currentColor', 'aria-hidden': true },
      h('rect', { x: 5, y: 5, width: 14, height: 14, rx: 3 }))
    const CloseGlyph = () => h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', 'aria-hidden': true },
      h('path', { d: 'M6 6l12 12M18 6L6 18' }))

    /** Control with the stock look when primitives are available. */
    function IconButton({ label, className, onClick, disabled, onPointerEnter, onPointerDown, onFocus, children }) {
      if (SharedButton !== null) {
        return h(SharedButton, { type: 'button', className, size: 'sm', 'aria-label': label, disabled, onClick, onPointerEnter, onPointerDown, onFocus }, children)
      }
      return h('button', { type: 'button', className, 'aria-label': label, disabled, onClick, onPointerEnter, onPointerDown, onFocus }, children)
    }

    /** The stock trigger: 28 px icon button wrapped in the shared tooltip. */
    function Trigger({ disabled, onClick }) {
      // The device opens when the button is pressed, never on hover: merely
      // moving the pointer must not light the microphone indicator.
      const warm = () => {
        if (!disabled) void sharedMic.open().catch(() => undefined)
      }
      const button = h(IconButton, {
        label: 'Dictar',
        className: 'dsh-dv-trigger',
        disabled,
        onClick,
        onPointerDown: warm,
      }, h(MicrophoneGlyph, null))
      if (SharedTooltip === null) {
        return h('span', { className: 'dsh-dv-anchor' }, button, h('span', { className: 'dsh-dv-tip', role: 'tooltip' }, 'Dictar'))
      }
      return h(SharedTooltip, { label: 'Dictar', side: 'top', portal: true },
        h('span', { className: 'dsh-dv-anchor' }, button))
    }

    /**
     * Recording indicator: one sharp, stroked wave.
     *
     * The line follows the peak of each block, so consonants draw spikes the
     * way a voice recorder does; a blurred copy behind adds the glow without
     * filling the shape. A thin line at rest means the microphone is open and
     * silent, which is information the bars could not give.
     */
    function ListeningIndicator({ capture, label }) {
      const line = useRef(null)
      const glow = useRef(null)
      useEffect(() => {
        const samples = 150
        const values = new Array(samples).fill(0)
        const width = 480
        const mid = 20
        const step = width / (samples - 1)
        let frame
        let previous = 0
        const draw = (now) => {
          if (now - previous >= 16) {
            previous = now
            // Instantaneous peak from the analyser: 16 ms of audio, so the line
            // carries the shape of the syllables instead of an average. If the
            // analyser reports nothing, the last processed block is used so the
            // drawing still moves.
            // Mirrored bars: the level of each slice of the window, drawn as a
            // vertical stroke above and below the centre line. It is an envelope,
            // which is exactly what the reference image shows, and it never
            // aliases into crossed lines.
            const ring = capture === undefined ? undefined : capture.wave
            let path = ''
            if (ring !== undefined) {
              const size = Math.max(1, Math.floor(ring.length / samples))
              const start = capture.waveAt
              for (let index = 0; index < samples; index++) {
                let peak = 0
                for (let offset = 0; offset < size; offset++) {
                  const value = Math.abs(ring[(start + index * size + offset) % ring.length])
                  if (value > peak) peak = value
                }
                const height = Math.min(1, peak / 0.3) * 17
                const x = (index * step).toFixed(1)
                path += `M ${x} ${(mid - height).toFixed(1)} L ${x} ${(mid + height).toFixed(1)} `
              }
            }
            if (line.current !== null) line.current.setAttribute('d', path)
            if (glow.current !== null) glow.current.setAttribute('d', path)
          }
          frame = requestAnimationFrame(draw)
        }
        frame = requestAnimationFrame(draw)
        return () => { cancelAnimationFrame(frame) }
      }, [capture])
      return h('span', { className: 'dsh-dv-meter-wrap' },
        h('svg', {
          className: 'dsh-dv-voice',
          viewBox: '0 0 480 40',
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': label,
        },
          h('defs', null,
            h('linearGradient', { id: 'dsh-dv-voice-gradient', x1: '0', y1: '0', x2: '1', y2: '0' },
              h('stop', { offset: '0%', stopColor: '#4f8cff' }),
              h('stop', { offset: '52%', stopColor: '#a855f7' }),
              h('stop', { offset: '100%', stopColor: '#ff5fa2' })),
            h('filter', { id: 'dsh-dv-voice-glow', x: '-5%', y: '-60%', width: '110%', height: '220%' },
              h('feGaussianBlur', { stdDeviation: '3' }))),
          h('path', {
            ref: glow, fill: 'none', stroke: 'url(#dsh-dv-voice-gradient)', strokeWidth: 2.2,
            strokeLinecap: 'round', strokeLinejoin: 'round', filter: 'url(#dsh-dv-voice-glow)',
            opacity: 0.45, vectorEffect: 'non-scaling-stroke',
          }),
          h('path', {
            ref: line, fill: 'none', stroke: 'url(#dsh-dv-voice-gradient)', strokeWidth: 1,
            strokeLinecap: 'round', strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke',
          })))
    }

    /**
     * Encode mono 16-bit samples as the canonical WAV the Host accepts.
     * @param samples - 16 kHz mono PCM.
     * @returns complete little-endian WAV bytes.
     */
    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => { for (let index = 0; index < value.length; index++) bytes[at + index] = value.charCodeAt(index) }
      text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      new Uint8Array(bytes.buffer, 44).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.length * 2))
      return bytes
    }

    /**
     * The microphone, kept open around a dictation.
     *
     * Opening the device and the audio graph costs a couple of hundred
     * milliseconds, and whatever is said meanwhile is lost: that is the clipped
     * first word. Warming it up when the pointer reaches the button and holding
     * the last half second of audio makes the phrase start where the user did.
     */
    const sharedMic = {
      stream: undefined,
      context: undefined,
      processor: undefined,
      analyser: undefined,
      analyserBuffer: undefined,
      sink: undefined,
      backlog: [],
      timer: 0,
      opening: undefined,

      /** @returns the peak of the last few milliseconds, for the wave. */
      instantPeak() {
        if (this.analyser === undefined) return 0
        if (this.analyserBuffer === undefined) this.analyserBuffer = new Float32Array(this.analyser.fftSize)
        this.analyser.getFloatTimeDomainData(this.analyserBuffer)
        let peak = 0
        for (const sample of this.analyserBuffer) {
          const magnitude = Math.abs(sample)
          if (magnitude > peak) peak = magnitude
        }
        return peak
      },

      async open() {
        clearTimeout(this.timer)
        if (this.processor !== undefined) return
        // One acquisition at a time: a second call joins the one in flight.
        this.opening ??= (async () => {
          const devices = navigator.mediaDevices
          if (devices === undefined) throw new Error('Este navegador no puede grabar audio')
          const stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
          const context = new AudioContext({ sampleRate: 16000 })
          await context.resume()
          const source = context.createMediaStreamSource(stream)
          const mute = context.createGain()
          mute.gain.value = 0
          // 256 samples is 16 ms at 16 kHz: short enough that the drawing shows
          // the shape of speech instead of a moving average.
          const analyser = context.createAnalyser()
          analyser.fftSize = 256
          source.connect(analyser)
          // The analyser must reach the destination through the muted gain too:
          // an unconnected analyser is not guaranteed to process.
          analyser.connect(mute)
          // 256 samples is 16 ms at 16 kHz: the wave sees the shape of each
          // syllable, and no AnalyserNode is involved (it reported zeros).
          const processor = context.createScriptProcessor(256, 1, 1)
          processor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0)
            // The microphone is the single owner of the level: the drawing reads
            // it from here so a stale Capture instance cannot show zeros.
            let instant = 0
            for (let index = 0; index < input.length; index++) {
              const magnitude = Math.abs(input[index])
              if (magnitude > instant) instant = magnitude
            }
            this.peakValue = instant
            if (this.sink !== undefined) { this.sink(input); return }
            // Pre-roll: only the last half second is worth keeping.
            this.backlog.push(Float32Array.from(input))
            while (this.backlog.length > 4) this.backlog.shift()
          }
          source.connect(processor)
          processor.connect(mute)
          mute.connect(context.destination)
          this.stream = stream
          this.context = context
          this.processor = processor
          this.analyser = analyser
        })().finally(() => { this.opening = undefined })
        await this.opening
      },

      /**
       * Hand over the buffered pre-roll and route new audio to the sink.
       * @param sink - receives every input block from now on.
       * @returns the pre-roll blocks, oldest first.
       */
      attach(sink) {
        clearTimeout(this.timer)
        const backlog = this.backlog
        this.backlog = []
        this.sink = sink
        return backlog
      },

      detach() {
        this.sink = undefined
        // Close at once: the system microphone indicator must go out as soon as
        // the dictation ends, not two seconds later.
        this.releaseIn(0)
      },

      releaseIn(delay) {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => { void this.close() }, delay)
      },

      async close() {
        clearTimeout(this.timer)
        this.sink = undefined
        if (this.processor !== undefined) {
          this.processor.onaudioprocess = null
          try { this.processor.disconnect() } catch { /* already detached */ }
          this.processor = undefined
        }
        this.stream?.getTracks().forEach((track) => { track.stop() })
        this.stream = undefined
        const context = this.context
        this.context = undefined
        this.analyser = undefined
        this.analyserBuffer = undefined
        this.backlog = []
        if (context !== undefined && context.state !== 'closed') {
          try { await context.close() } catch { /* already closed */ }
        }
      },
    }

    /** One dictation on top of the warm microphone. */
    class Capture {
      constructor(onFrame) {
        this.onFrame = onFrame
        this.pending = new Float32Array(0)
        this.chunks = []
        this.level = 0
        this.peakLevel = 0
        this.rawPeakValue = 0
        // Ring of raw samples for the oscilloscope drawing (3 s at 16 kHz:
        // a shorter window made the shape fly across in under a second).
        this.wave = new Float32Array(48000)
        this.waveAt = 0
        this.waveFull = false
        this.attached = false
      }

      /** @returns the last measured RMS level. */
      amplitude() { return this.level }

      /** @returns the recent peak, which is what draws the spiky wave. */
      peak() { return this.peakLevel }

      /** @returns the instantaneous peak, sampled straight from the analyser. */
      instantPeak() { return sharedMic.instantPeak() }

      /** @returns the peak of the last processed block, without decay. */
      rawPeak() { return this.rawPeakValue }

      async start() {
        await sharedMic.open()
        const backlog = sharedMic.attach((input) => this.#push(input))
        this.attached = true
        // What was said between reaching the button and pressing it is the
        // beginning of the phrase, so it belongs to the recording.
        for (const block of backlog) this.#push(block)
      }

      #push(input) {
        let sum = 0
        let peak = 0
        for (let index = 0; index < input.length; index++) {
          const sample = input[index]
          sum += sample * sample
          const magnitude = Math.abs(sample)
          if (magnitude > peak) peak = magnitude
        }
        this.level = Math.sqrt(sum / input.length)
        this.rawPeakValue = peak
        for (let index = 0; index < input.length; index++) {
          this.wave[this.waveAt] = input[index]
          this.waveAt = (this.waveAt + 1) % this.wave.length
          if (this.waveAt === 0) this.waveFull = true
        }
        // Fast attack, slow decay: the peak holds long enough to be seen at
        // 64 ms blocks without smearing whole words together.
        this.peakLevel = Math.max(peak, this.peakLevel * 0.82)
        const merged = new Float32Array(this.pending.length + input.length)
        merged.set(this.pending)
        merged.set(input, this.pending.length)
        this.pending = merged
        while (this.pending.length >= FRAME_SAMPLES) {
          const frame = this.pending.slice(0, FRAME_SAMPLES)
          this.pending = this.pending.slice(FRAME_SAMPLES)
          this.#emit(frame)
        }
      }

      #emit(frame) {
        const pcm = new Int16Array(frame.length)
        for (let index = 0; index < frame.length; index++) {
          const value = Math.max(-1, Math.min(1, frame[index]))
          pcm[index] = Math.round(value * (value < 0 ? 32768 : 32767))
        }
        this.chunks.push(pcm)
        this.onFrame(pcm)
      }

      /** Finish capture, flush the tail and return every recorded sample. */
      async stop() {
        if (this.pending.length > 0) {
          const tail = new Float32Array(FRAME_SAMPLES)
          tail.set(this.pending)
          this.pending = new Float32Array(0)
          this.#emit(tail)
        }
        await this.dispose()
        const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const merged = new Int16Array(total)
        let offset = 0
        for (const chunk of this.chunks) { merged.set(chunk, offset); offset += chunk.length }
        this.chunks = []
        return merged
      }

      async dispose() {
        if (this.attached) {
          this.attached = false
          sharedMic.detach()
        }
      }
    }

    async function request(path, options = {}) {
      const response = await fetch(`${ROUTE}${path}`, { cache: 'no-store', ...options })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value.message ?? value.error ?? `HTTP ${response.status}`)
      return value
    }

    /** Live dictation row: microphone, waveform, progress and the final rewrite. */
    /** Openers that, in Spanish, almost always begin a question. */
    const QUESTION_CUES = ['te parece', 'te gusta', 'puedes', 'podrías', 'podriais', 'crees', 'sabes', 'tienes', 'cómo', 'qué', 'quién', 'dónde', 'cuándo', 'cuál', 'por qué', 'verdad']

    /**
     * Close questions that the recognizer left as statements.
     *
     * Deliberately conservative: only a sentence that opens with a clear
     * interrogative formula and ends in a full stop is converted. Anything
     * doubtful is left untouched, because inventing punctuation is worse than
     * missing it.
     * @param text - transcript.
     * @returns the transcript with the obvious questions marked.
     */
    function addQuestionMarks(text) {
      const parts = text.split(/(?<=[.!?])\s+/)
      let changed = false
      const fixed = parts.map((part) => {
        if (!part.endsWith('.') || part.startsWith('¿') || part.includes('?')) return part
        const lower = part.toLowerCase()
        if (!QUESTION_CUES.some((cue) => lower.startsWith(cue))) return part
        changed = true
        return `¿${part.slice(0, -1)}?`
      })
      return changed ? fixed.join(' ') : text
    }

    function LiveDictation({ sessionId, inputActions, locked, onActiveChange, conversation }) {
      const [phase, setPhase] = useState('idle')
      const [message, setMessage] = useState('')
      const [pending, setPending] = useState('')
      const [progress, setProgress] = useState(null)
      const active = useRef(undefined)
      const generation = useRef(0)

      const expanded = phase !== 'idle'
      useLayoutEffect(() => { onActiveChange(expanded); return () => { onActiveChange(false) } }, [expanded, onActiveChange])

      const feedback = (text) => { setMessage(text); setPhase('feedback') }

      /**
       * Sending while dictating ends the dictation on the spot.
       *
       * The message already carries the text that was in the composer, so the
       * recording is closed without inserting anything: inserting the final
       * transcript after the send would leave it behind in an empty draft.
       */
      const stopForSend = (run) => {
        if (active.current !== run) return
        active.current = undefined
        // Invalidate any transcription in flight: it must not insert its result
        // into the draft once the message has already been sent.
        generation.current++
        clearTimeout(run.timer)
        run.abort.abort()
        void run.capture.dispose().catch(() => undefined)
        if (run.id !== undefined) {
          void request(`/close?id=${encodeURIComponent(run.id)}`, { method: 'POST' }).catch(() => undefined)
        }
        setMessage(''); setPending(''); setPhase('idle')
      }

      // A new sent message is the signal: the user pressed Send during the
      // dictation, so the bar must return to its resting state immediately.
      useEffect(() => {
        if (conversation === undefined || sessionId === undefined) return () => undefined
        let unsubscribe
        const check = () => {
          const run = active.current
          if (run === undefined || (run.phase !== 'recording' && run.phase !== 'transcribing')) return
          let snapshot
          try { snapshot = conversation.binding(sessionId).snapshot.getSnapshot() } catch { return }
          const chat = snapshot && snapshot.views ? snapshot.views.get('chat') : undefined
          if (chat === undefined || chat.nodes === undefined) return
          for (const node of chat.nodes.values()) {
            if (node.kind !== 'user' && node.kind !== 'steering') continue
            const time = node.data && node.data.time
            if (typeof time === 'number' && time >= run.startedAt) { stopForSend(run); return }
          }
        }
        try { unsubscribe = conversation.binding(sessionId).snapshot.subscribe(check) } catch { return () => undefined }
        check()
        return () => { if (unsubscribe !== undefined) unsubscribe() }
      }, [conversation, sessionId])

      /** Replace the provisional text; false means the user edited first. */
      const applyLive = (run, text) => {
        if (run.live === text || run.conflicted) return
        const span = { start: run.start, end: run.start + run.live.length, draftRev: run.rev }
        if (!inputActions.insertText(text, span)) { run.conflicted = true; return }
        run.live = text
        run.rev = inputActions.captureInsertion().draftRev
      }

      const stopCapture = async (run) => {
        const samples = await run.capture.stop()
        run.stopped = true
        await run.queue
        return samples
      }

      const release = (run) => {
        clearTimeout(run.timer)
        run.abort.abort()
        void run.capture.dispose().catch(() => undefined)
        if (run.id !== undefined) void request(`/close?id=${encodeURIComponent(run.id)}`, { method: 'POST' }).catch(() => undefined)
      }

      const cancel = () => {
        generation.current++
        const run = active.current
        active.current = undefined
        if (run !== undefined) {
          if (run.live !== '') {
            try { inputActions.insertText('', { start: run.start, end: run.start + run.live.length, draftRev: run.rev }) } catch { /* draft locked */ }
          }
          release(run)
        }
        setProgress(null); setPending(''); setMessage(''); setPhase('idle')
      }

      useEffect(() => {
        setPending(''); setMessage(''); setProgress(null); setPhase('idle')
        const blur = () => { if (active.current !== undefined && active.current.phase === 'recording') cancel() }
        const visibility = () => { if (document.hidden && active.current !== undefined && active.current.phase !== 'transcribing') cancel() }
        const escape = (event) => { if (event.key === 'Escape' && active.current !== undefined) { event.preventDefault(); cancel() } }
        window.addEventListener('blur', blur)
        document.addEventListener('visibilitychange', visibility)
        document.addEventListener('keydown', escape)
        return () => {
          window.removeEventListener('blur', blur)
          document.removeEventListener('visibilitychange', visibility)
          document.removeEventListener('keydown', escape)
          const run = active.current
          active.current = undefined
          if (run !== undefined) release(run)
        }
      }, [sessionId])

      /** Wait for the streaming model without holding up the recording. */
      const waitForModel = async (run) => {
        try {
          let state = await request('/status')
          if (state.phase === 'ready') return true
          setProgress(state)
          if (state.phase !== 'preparing') await request('/prepare', { method: 'POST' })
          for (;;) {
            await new Promise((resolve) => { setTimeout(resolve, POLL_MS) })
            if (run.stale() || run.stopped) return false
            state = await request('/status')
            setProgress(state)
            if (state.phase === 'ready') return true
            if (state.phase === 'failed') {
              setMessage(`El dictado en vivo no está disponible: ${state.message ?? ''}`)
              return false
            }
          }
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error))
          return false
        }
      }

      /** Send one captured frame once the streaming side has a stream id. */
      const sendChunk = (run, pcm) => {
        run.queue = run.queue.then(async () => {
          if (run.id === undefined) return
          const response = await fetch(`${ROUTE}/chunk?id=${encodeURIComponent(run.id)}`, { method: 'POST', body: pcm })
          if (!response.ok) return
          const value = await response.json().catch(() => ({}))
          if (typeof value.text === 'string') applyLive(run, value.text)
        }).catch(() => undefined)
      }

      const start = async () => {
        if (locked || active.current !== undefined) return
        const token = ++generation.current
        setMessage(''); setPending('')
        const run = {
          phase: 'requesting',
          startedAt: Date.now(),
          backlog: [],
          queue: Promise.resolve(),
          abort: new AbortController(),
          live: '',
          start: 0,
          rev: 0,
          stopped: false,
          conflicted: false,
          stale: () => token !== generation.current,
        }
        run.capture = new Capture((pcm) => {
          // The microphone opens before the model does: the first frames are
          // kept and replayed the moment the streaming engine answers, so the
          // user never waits to start talking.
          if (run.id === undefined) {
            if (run.backlog.length < 600) run.backlog.push(pcm)
            return
          }
          sendChunk(run, pcm)
        })
        active.current = run
        try {
          const span = inputActions.captureInsertion()
          run.start = span.start
          run.rev = span.draftRev
          await run.capture.start()
          if (run.stale()) { cancel(); return }
          run.phase = 'recording'
          setPhase('recording')
          run.timer = setTimeout(() => { void finish() }, MAX_SECONDS * 1000)
          // The engine warms up while the user speaks; the recording never
          // waits for it, and a failure here still leaves the final pass.
          void (async () => {
            if (!await waitForModel(run)) return
            const opened = await request('/open', { method: 'POST' })
            if (run.stale()) {
              void request(`/close?id=${encodeURIComponent(opened.id)}`, { method: 'POST' }).catch(() => undefined)
              return
            }
            run.id = opened.id
            const pendingFrames = run.backlog
            run.backlog = []
            for (const pcm of pendingFrames) sendChunk(run, pcm)
          })().catch((error) => {
            if (!run.stale()) setMessage(error instanceof Error ? error.message : String(error))
          })
        } catch (error) {
          active.current = undefined
          release(run)
          feedback(error instanceof Error ? error.message : String(error))
        }
      }

      const finish = async () => {
        const run = active.current
        if (run === undefined || run.phase !== 'recording') return
        run.phase = 'transcribing'
        clearTimeout(run.timer)
        const token = generation.current
        try {
          const samples = await stopCapture(run)
          const wav = samples.length > 0 ? encodeWave(samples) : null
          // The text is already in the draft: it was written while recording,
          // replacing its own range on every partial. Writing it again here is
          // what duplicated the transcript when stopping.
          const provisional = run.live
          let placed = provisional.length
          // One pass at stop: mark the questions the recognizer left flat.
          const polished = addQuestionMarks(provisional)
          if (polished !== provisional && placed > 0
            && inputActions.insertText(polished, { start: run.start, end: run.start + placed, draftRev: run.rev })) {
            run.rev = inputActions.captureInsertion().draftRev
            placed = polished.length
          }
          setPhase('idle')
          active.current = undefined
          // Keep the stream clean in the engine, but skip the final pass: the
          // text is left exactly as it is so the user can edit it.
          if (run.id !== undefined) {
            void request(`/close?id=${encodeURIComponent(run.id)}`, { method: 'POST' }).catch(() => undefined)
          }
          if (!CORRECT_AFTER_STOP || wav === null || placed === 0) return
          const final = await request('/final', { method: 'POST', body: wav }).catch(() => null)
          if (final === null || typeof final.text !== 'string') return
          const text = final.text.trim()
          if (token !== generation.current || text === '' || text === provisional) return
          // Replace the provisional text with the corrected one. If the user has
          // sent or edited the draft, the revision guard refuses and nothing is
          // written: no stray text under the sent message.
          const span = { start: run.start, end: run.start + placed, draftRev: run.rev }
          if (inputActions.insertText(text, span)) run.rev = inputActions.captureInsertion().draftRev
        } catch (error) {
          feedback(error instanceof Error ? error.message : String(error))
        } finally {
          if (token === generation.current) active.current = undefined
        }
      }

      if (!expanded) {
        return h(React.Fragment, null,
          h('style', { key: 'dsh-dv-style' }, STYLE),
          h(Trigger, { disabled: locked, onClick: () => { void start() } }))
      }

      const run = active.current
      const state = progress ?? {}
      const total = state.totalBytes
      const done = state.completedBytes
      const percent = Number.isFinite(total) && total > 0 && Number.isFinite(done) ? Math.min(100, Math.round((done / total) * 100)) : undefined

      return h(React.Fragment, null,
        h('style', { key: 'dsh-dv-style' }, STYLE),
        h('div', { className: 'dsh-dv-row', 'data-voice-activity': phase },
        h(IconButton, { label: pending === '' ? 'Cancelar' : 'Descartar', className: 'dsh-dv-round', onClick: cancel }, h(CloseGlyph, null)),
        phase === 'recording'
          ? h(ListeningIndicator, { capture: run === undefined ? undefined : run.capture, label: 'Grabando' })
          : h('span', { className: 'dsh-dv-message', role: 'status', title: pending === '' ? message : pending },
            (phase === 'requesting' || phase === 'transcribing' || phase === 'preparing') && SharedStateDot !== null ? h(SharedStateDot, { state: 'ongoing' }) : null,
            phase === 'feedback'
              ? message
              : phase === 'preparing'
                ? `Preparando el dictado en vivo${percent === undefined ? '' : ` · ${percent} %`}`
                : phase === 'requesting' ? 'Preparando…' : 'Transcribiendo…'),
        phase === 'recording' ? h(IconButton, { label: 'Parar', className: 'dsh-dv-round', onClick: () => { void finish() } }, h(StopGlyph, null)) : null,
        phase === 'feedback' ? (pending !== ''
          ? h(IconButton, {
            label: 'Insertar',
            className: 'dsh-dv-round',
            onClick: () => {
              const span = inputActions.captureInsertion()
              if (inputActions.insertText(pending, span)) { setPending(''); setPhase('idle') }
            },
          }, h(MicrophoneGlyph, { size: 16 }))
          : h(IconButton, { label: 'Reintentar', className: 'dsh-dv-round', disabled: locked, onClick: () => { void start() } }, h(MicrophoneGlyph, null))) : null))
    }

    /** Microphone level for the sound panel: one RMS/peak reading per block, no recording. */
    class Meter {
      constructor() {
        this.context = undefined
        this.stream = undefined
        this.processor = undefined
        this.rms = 0
        this.peak = 0
      }

      async start() {
        const devices = navigator.mediaDevices
        if (devices === undefined) throw new Error('Este navegador no puede leer el micrófono')
        const stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        this.stream = stream
        const context = new AudioContext({ sampleRate: 16000 })
        this.context = context
        await context.resume()
        const source = context.createMediaStreamSource(stream)
        const mute = context.createGain()
        mute.gain.value = 0
        const processor = context.createScriptProcessor(2048, 1, 1)
        this.processor = processor
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0)
          let sum = 0
          let peak = 0
          for (let index = 0; index < input.length; index++) {
            const sample = input[index]
            sum += sample * sample
            const magnitude = Math.abs(sample)
            if (magnitude > peak) peak = magnitude
          }
          this.rms = Math.sqrt(sum / input.length)
          // Peak hold with a slow decay, so a single loud word stays visible.
          this.peak = Math.max(peak, this.peak * 0.992)
        }
        source.connect(processor)
        processor.connect(mute)
        mute.connect(context.destination)
      }

      async stop() {
        if (this.processor !== undefined) {
          this.processor.onaudioprocess = null
          try { this.processor.disconnect() } catch { /* already detached */ }
          this.processor = undefined
        }
        this.stream?.getTracks().forEach((track) => { track.stop() })
        this.stream = undefined
        const context = this.context
        this.context = undefined
        if (context !== undefined && context.state !== 'closed') {
          try { await context.close() } catch { /* already closed */ }
        }
      }
    }

    /** Sidebar icon: a microphone with a level scale. */
    function PanelIcon({ size = 18, active = false }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', { viewBox: '0 0 24 24', width: edge, height: edge, 'aria-hidden': true, style: { display: 'block', opacity: active ? 1 : 0.82 } },
        h('rect', { x: 9, y: 3, width: 6, height: 10, rx: 3, fill: 'currentColor' }),
        h('path', { d: 'M6.5 11a5.5 5.5 0 0 0 11 0', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M12 16.5V20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
        h('path', { d: 'M4 13h2M18 13h2', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }))
    }

    /**
     * Sound checks for the dictation: the microphone as it is right now, and
     * the speaker playing a real sentence at a volume the user picks.
     */
    function SoundPanel() {
      const [level, setLevel] = useState({ rms: 0, peak: 0 })
      const [failure, setFailure] = useState('')
      const [testing, setTesting] = useState(false)
      const [volume, setVolume] = useState(() => {
        try {
          const stored = localStorage.getItem('dsh:dictado-vivo:volume')
          return stored === null ? 100 : Number(stored)
        } catch { return 100 }
      })
      const [status, setStatus] = useState(null)
      const [last, setLast] = useState(null)
      // The meter only runs on demand: opening the page must not switch the
      // microphone on by itself.
      const [micOn, setMicOn] = useState(false)
      const meter = useRef(undefined)
      const frame = useRef(0)

      const load = async () => {
        try {
          const [state, record] = await Promise.all([
            fetch(`${ROUTE}/status`, { cache: 'no-store' }).then((response) => response.json()),
            fetch(`${ROUTE}/last`, { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
          ])
          setStatus(state)
          setLast(record ?? null)
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }

      useEffect(() => { void load() }, [])

      useEffect(() => {
        if (!micOn) return () => undefined
        let cancelled = false
        let previous = 0
        const draw = (now) => {
          const current = meter.current
          // Ten updates a second is plenty for a level bar and costs far less
          // than re-rendering on every animation frame.
          if (current !== undefined && now - previous >= 100) {
            previous = now
            setLevel({ rms: current.rms, peak: current.peak })
          }
          frame.current = requestAnimationFrame(draw)
        }
        void (async () => {
          try {
            const next = new Meter()
            meter.current = next
            await next.start()
            if (cancelled) { void next.stop(); return }
            frame.current = requestAnimationFrame(draw)
          } catch (error) {
            setFailure(error instanceof Error ? error.message : String(error))
          }
        })()
        return () => {
          cancelled = true
          cancelAnimationFrame(frame.current)
          const current = meter.current
          meter.current = undefined
          if (current !== undefined) void current.stop()
        }
      }, [micOn])

      useEffect(() => {
        try { localStorage.setItem('dsh:dictado-vivo:volume', String(volume)) } catch { /* private mode */ }
      }, [volume])

      const testSpeaker = async () => {
        setTesting(true)
        setFailure('')
        try {
          const response = await fetch('/read-aloud/tts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'Esta es una prueba de volumen del altavoz: uno, dos, tres.' }),
          })
          if (!response.ok) throw new Error('La voz de lectura no está disponible')
          const url = URL.createObjectURL(await response.blob())
          const audio = new Audio(url)
          audio.volume = volume / 100
          const release = () => { URL.revokeObjectURL(url); setTesting(false) }
          audio.onended = release
          audio.onerror = release
          await audio.play()
        } catch (error) {
          // Without the reader, a tone still tells whether the output works.
          try {
            const context = new AudioContext()
            const oscillator = context.createOscillator()
            const gain = context.createGain()
            gain.gain.value = (volume / 100) * 0.25
            oscillator.frequency.value = 440
            oscillator.connect(gain)
            gain.connect(context.destination)
            oscillator.onended = () => { void context.close(); setTesting(false) }
            oscillator.start()
            oscillator.stop(context.currentTime + 1.2)
          } catch (fallbackError) {
            setTesting(false)
            setFailure(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
          }
        }
      }

      const rmsDb = level.rms <= 0.001 ? -60 : 20 * Math.log10(level.rms)
      const peakDb = level.peak <= 0.001 ? -60 : 20 * Math.log10(level.peak)
      const quality = rmsDb < -45 ? 'low' : rmsDb > -12 ? 'high' : 'ok'
      const qualityText = quality === 'low' ? 'Bajo: sube la entrada' : quality === 'high' ? 'Alto: puede saturar' : 'Nivel correcto'
      const percent = Math.max(0, Math.min(100, ((rmsDb + 60) / 60) * 100))

      const state = status === null ? 'Consultando…'
        : status.phase === 'ready' ? 'Motor en vivo listo'
          : status.phase === 'preparing'
            ? (status.totalBytes > 0 && Number.isFinite(status.completedBytes)
              ? `Preparando el modelo · ${Math.round((status.completedBytes / status.totalBytes) * 100)} %`
              : 'Preparando el modelo…')
            : status.phase === 'failed' ? `Error: ${status.message ?? 'desconocido'}`
              : 'Sin preparar: se descarga la primera vez que dictes'

      return h('div', { className: 'dsh-dv-page' },
        h('header', { className: 'dsh-dv-head' },
          h('h1', null, 'Dictado y sonido'),
          h('p', null, 'Comprueba de un vistazo que el micrófono capta con nivel y que el altavoz suena como debe.'),
          h('button', { type: 'button', className: 'dsh-dv-action', onClick: () => { void load() } }, 'Actualizar')),
        h('section', { className: 'dsh-dv-card' },
          h('h2', null, 'Estado'),
          h('p', null, state),
          status === null ? null : h('p', { className: 'dsh-dv-note' }, status.worker
            ? 'Motor en vivo cargado: el texto aparece mientras hablas.'
            : 'Motor en vivo apagado: se carga al empezar a dictar (unos segundos la primera vez).'),
          h('p', { className: 'dsh-dv-note' }, 'El texto final lo escribe el proveedor configurado en DSH; aquí se mide el audio, no el modelo.')),
        h('section', { className: 'dsh-dv-card' },
          h('h2', null, 'Micrófono'),
          h('div', { className: 'dsh-dv-meter', 'data-level': quality }, h('span', { style: { width: `${percent}%` } })),
          h('div', { className: 'dsh-dv-read' },
            h('span', null, qualityText),
            h('span', null, `${rmsDb <= -60 ? 'silencio' : `${rmsDb.toFixed(0)} dB`} · pico ${peakDb <= -60 ? '—' : `${peakDb.toFixed(0)} dB`}`)),
          h('div', { className: 'dsh-dv-rowline', style: { marginTop: '8px' } },
            h('button', { type: 'button', className: 'dsh-dv-action', onClick: () => setMicOn((value) => !value) },
              micOn ? 'Parar la prueba' : 'Empezar la prueba de micrófono')),
          h('p', { className: 'dsh-dv-note' }, 'El micrófono solo se abre mientras la prueba está activa. Habla normal: el verde va de −30 a −18 dBFS; si se queda en ámbar, sube la entrada en Windows.')),
        h('section', { className: 'dsh-dv-card' },
          h('h2', null, 'Altavoz'),
          h('div', { className: 'dsh-dv-rowline' },
            h('input', {
              type: 'range', min: 0, max: 100, value: volume,
              'aria-label': 'Volumen de la prueba',
              onChange: (event) => setVolume(Number(event.target.value)),
            }),
            h('span', { className: 'dsh-dv-read' }, `${volume} %`)),
          h('div', { className: 'dsh-dv-rowline', style: { marginTop: '8px' } },
            h('button', { type: 'button', className: 'dsh-dv-action', disabled: testing, onClick: () => { void testSpeaker() } },
              testing ? 'Sonando…' : 'Probar el altavoz')),
          h('p', { className: 'dsh-dv-note' }, 'Reproduce una frase con la voz de lectura a este volumen. Para el resto del sistema manda el volumen de Windows.')),
        last === null ? null : h('section', { className: 'dsh-dv-card' },
          h('h2', null, 'Última prueba'),
          h('p', { className: 'dsh-dv-note' }, `${String(last.at ?? '').replace('T', ' ').slice(0, 19)} · ${last.seconds} s · pico ${last.peakDbfs} dBFS · media ${last.rmsDbfs} dBFS · saturación ${last.clippingPercent} %`),
          last.text ? h('p', { className: 'dsh-dv-quote' }, last.text) : null),
        failure === '' ? null : h('p', { className: 'dsh-dv-note', role: 'status' }, failure),
        h('style', null, STYLE))
    }

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        const conversation = ctx.uiConversation
        ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
          name: 'conversation.input.activity',
          id: 'dictado-vivo',
          order: 10,
          inject: () => ({ conversation }),
        }, LiveDictation))
        if (PANEL_ENABLED) {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'dictado-vivo',
            order: 110,
            label: 'Dictado y sonido',
          }, PanelIcon))
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'dictado-vivo',
          }, SoundPanel))
        }
      },
    }
  },
})
