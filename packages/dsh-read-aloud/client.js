/**
 * Read-aloud button for the composer.
 *
 * A speaker toggle sits beside the microphone. While it is active, every
 * assistant reply that finishes while the page is open is read aloud. The Host
 * synthesizes the reply with a local Piper voice through sherpa-onnx and the
 * page plays the WAV with a real audio element, so mute pauses and resumes
 * instead of restarting. The next chunk is prefetched while the current one
 * plays, so long replies have no silent gaps.
 *
 * The text comes from the public Chat snapshot exposed by
 * `ctx.uiConversation`, so the plugin never touches another plugin's DOM.
 */
window.__ModuleLoader__.load({
  id: '@navasfj/dsh-read-aloud',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    // The microphone beside this button renders DSH's shared Tooltip. Reusing
    // the same component keeps both hints identical (same box, font, gap and
    // portal placement) instead of approximating the look with local CSS.
    const primitives = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return null }
    })()
    const SharedTooltip = primitives === null ? null : primitives.Tooltip

    const STORAGE_KEY = 'dsh:read-aloud:enabled'
    // One synthesis request carries several sentences; the Host pays a model
    // inference per request, so very small chunks would add needless latency.
    const MAX_CHUNK = 800
    // A mute longer than this forgets the paused reply: pressing the button
    // again starts cleanly instead of resuming an old narration.
    const MUTE_DISCARD_MS = 5000
    const TTS_ROUTE = '/read-aloud/tts'

    const STYLE = `
.dsh-ra-anchor{position:relative;display:inline-flex;align-items:center;order:2}
.dsh-ra-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-state-error-primary,#dc2626);cursor:pointer;padding:0;transition:opacity .15s,color .15s}
.dsh-ra-button:hover:not(:disabled){opacity:.78}
.dsh-ra-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,currentColor);outline-offset:2px}
.dsh-ra-button[aria-pressed="true"]{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dsh-ra-button[disabled]{opacity:.35;cursor:default}
.dsh-ra-tip{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);display:none;padding:4px 8px;border-radius:6px;background:#2b2f36;color:#ffffff;font-size:12px;line-height:16px;white-space:nowrap;pointer-events:none;z-index:20;box-shadow:0 6px 18px rgba(0,0,0,.28)}
.dsh-ra-anchor:hover .dsh-ra-tip,.dsh-ra-anchor:focus-within .dsh-ra-tip{display:block}
`

    /** Strip Markdown scaffolding that would be read character by character. */
    function plainText(text) {
      return text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(\*|_)(.*?)\1/g, '$2')
        .replace(/~~(.*?)~~/g, '$1')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    /** Split one reply into Host-sized pieces; each becomes one WAV. */
    function chunkText(text) {
      const chunks = []
      let current = ''
      for (const sentence of text.split(/(?<=[.!?…;:])\s+/)) {
        if (sentence.length > MAX_CHUNK) {
          if (current !== '') { chunks.push(current); current = '' }
          let rest = sentence
          while (rest.length > MAX_CHUNK) {
            let cut = rest.lastIndexOf(', ', MAX_CHUNK)
            if (cut < 200) cut = rest.lastIndexOf(' ', MAX_CHUNK)
            if (cut < 200) cut = MAX_CHUNK
            chunks.push(rest.slice(0, cut + 1).trim())
            rest = rest.slice(cut + 1).trim()
          }
          current = rest
          continue
        }
        if (current !== '' && current.length + sentence.length + 1 > MAX_CHUNK) {
          chunks.push(current)
          current = ''
        }
        current = current === '' ? sentence : `${current} ${sentence}`
      }
      if (current !== '') chunks.push(current)
      return chunks
    }

    let queue = []
    let player = null
    let playerUrl = null
    let paused = false
    // Set while the voice-input toolbar owns the microphone: playback stays
    // silent so the transcript does not pick up the narration.
    let dictating = false
    let fetching = false
    let fetcher = null
    let requestId = 0
    let prefetched = null
    let prefetching = false
    let prefetchFetcher = null
    let discardTimer

    /** Release the current audio element and its object URL. */
    function releasePlayer() {
      if (player !== null) {
        player.onended = null
        player.onerror = null
        try { player.pause() } catch { /* already stopped */ }
        player.src = ''
        player = null
      }
      if (playerUrl !== null) {
        URL.revokeObjectURL(playerUrl)
        playerUrl = null
      }
    }

    /** Release the already-synthesized next chunk, if any. */
    function releasePrefetched() {
      if (prefetched !== null) {
        URL.revokeObjectURL(prefetched.url)
        prefetched = null
      }
    }

    /** Ask the Host for one WAV and return its object URL. */
    async function requestAudio(text, signal) {
      const response = await fetch(TTS_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      })
      if (!response.ok) throw new Error(`speech synthesis returned ${response.status}`)
      const blob = await response.blob()
      return URL.createObjectURL(blob)
    }

    /** Synthesize the following chunk while the current one plays. */
    function prefetchNext() {
      if (paused || prefetched !== null || prefetching || queue.length === 0) return
      const text = queue[0]
      prefetching = true
      const controller = new AbortController()
      prefetchFetcher = controller
      requestAudio(text, controller.signal)
        .then((url) => {
          if (paused) { URL.revokeObjectURL(url); return }
          prefetched = { text, url }
        })
        .catch(() => { /* the next pump reports the failure */ })
        .finally(() => {
          prefetching = false
          prefetchFetcher = null
        })
    }

    /** Play the next queued chunk, using the prefetched audio when it matches. */
    async function pump() {
      if (paused || dictating || player !== null || fetching || queue.length === 0) return
      fetching = true
      const id = ++requestId
      const text = queue[0]
      let url
      try {
        if (prefetched !== null && prefetched.text === text) {
          url = prefetched.url
          prefetched = null
        } else {
          const controller = new AbortController()
          fetcher = controller
          url = await requestAudio(text, controller.signal)
        }
      } catch (_error) {
        if (id === requestId) {
          fetching = false
          fetcher = null
          queue.shift()
          void pump()
        }
        return
      }
      if (id !== requestId) { URL.revokeObjectURL(url); return }
      fetching = false
      fetcher = null
      if (paused) { URL.revokeObjectURL(url); return }
      queue.shift()
      const audio = new Audio(url)
      player = audio
      playerUrl = url
      const settle = () => { releasePlayer(); void pump() }
      audio.onended = settle
      audio.onerror = settle
      audio.play().catch(settle)
      prefetchNext()
    }

    /** Queue one assistant reply for reading. */
    function enqueue(text) {
      const clean = plainText(text)
      if (clean === '') return
      queue.push(...chunkText(clean))
      void pump()
    }

    /** Mute: pause the audio element and keep the rest for a short while. */
    function pauseSpeaking() {
      if (paused) return
      paused = true
      requestId++
      if (fetcher !== null) { fetcher.abort(); fetcher = null }
      if (prefetchFetcher !== null) { prefetchFetcher.abort(); prefetchFetcher = null }
      fetching = false
      prefetching = false
      if (player !== null) {
        try { player.pause() } catch { /* already stopped */ }
      }
      clearTimeout(discardTimer)
      discardTimer = setTimeout(() => {
        discardTimer = undefined
        queue = []
        releasePrefetched()
        releasePlayer()
        paused = false
      }, MUTE_DISCARD_MS)
    }

    /** Continue the reply the mute interrupted, when the mute was short. */
    function resumeSpeaking() {
      // A dictation in progress keeps the microphone clean; the caller retries
      // when the toolbar releases it.
      if (dictating) return
      clearTimeout(discardTimer)
      discardTimer = undefined
      if (!paused) return
      paused = false
      if (player !== null) {
        player.play().catch(() => { releasePlayer(); void pump() })
        return
      }
      void pump()
    }

    /** Drop everything, including a paused reply (unmount, session change). */
    function stopSpeaking() {
      clearTimeout(discardTimer)
      discardTimer = undefined
      queue = []
      requestId++
      if (fetcher !== null) { fetcher.abort(); fetcher = null }
      if (prefetchFetcher !== null) { prefetchFetcher.abort(); prefetchFetcher = null }
      fetching = false
      prefetching = false
      paused = false
      dictating = false
      releasePrefetched()
      releasePlayer()
    }

    /**
     * Page-lifetime dedupe across watcher re-binds and repeated component
     * instances: one Chat node is queued at most once.
     */
    const delivered = new Set()

    /**
     * Follow one Session's Chat snapshot and read replies as they settle.
     *
     * Messages already settled when the watcher binds are treated as baseline,
     * so enabling the toggle never replays history. Replies that settle while
     * the toggle is off are recorded as seen but stay silent.
     */
    function createWatcher(uiConversation, isEnabled) {
      let sessionId
      let unsubscribe
      let retry
      let boundAt = Date.now()

      const sync = () => {
        if (sessionId === undefined) return
        let snapshot
        try {
          snapshot = uiConversation.binding(sessionId).snapshot.getSnapshot()
        } catch {
          return
        }
        const chat = snapshot && snapshot.views ? snapshot.views.get('chat') : undefined
        if (!chat || !chat.nodes) return
        for (const node of chat.nodes.values()) {
          // The Chat renderer kind of one Assistant step is `assistant-step`;
          // only its settled state carries the final, user-visible blocks.
          if (node.kind !== 'assistant-step' || !node.data) continue
          const data = node.data
          if (data.status !== 'settled') continue
          const key = `${sessionId}#${node.key}`
          if (delivered.has(key)) continue
          delivered.add(key)
          if (!isEnabled()) continue
          // Nodes that existed before this watcher bound are history; a reply
          // already streaming when the toggle turned on keeps a later time.
          if (typeof data.time === 'number' && data.time < boundAt - 5000) continue
          const text = (data.blocks ?? []).filter((block) => block.kind === 'text').map((block) => block.text).join('\n')
          enqueue(text)
        }
      }

      return {
        bind(id) {
          if (id === sessionId) return
          if (unsubscribe !== undefined) { unsubscribe(); unsubscribe = undefined }
          clearTimeout(retry)
          sessionId = id
          boundAt = Date.now()
          const attach = () => {
            let binding
            try {
              binding = uiConversation.binding(id)
            } catch {
              retry = setTimeout(attach, 1500)
              return
            }
            unsubscribe = binding.snapshot.subscribe(sync)
            sync()
          }
          attach()
        },
        dispose() {
          clearTimeout(retry)
          if (unsubscribe !== undefined) unsubscribe()
          unsubscribe = undefined
        },
      }
    }

    function readEnabled() {
      try { return window.localStorage.getItem(STORAGE_KEY) === '1' } catch { return false }
    }

    function writeEnabled(enabled) {
      try { window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0') } catch { /* private mode */ }
    }

    /**
     * Compact speaker toggle; `aria-pressed` carries the mute/active state.
     * @param props - Session scope and the injected conversation service.
     * @returns the toggle or null without a Session.
     */
    function ReadAloudToggle({ sessionId, uiConversation }) {
      const [enabled, setEnabled] = useState(readEnabled)
      const enabledRef = useRef(enabled)
      const available = typeof window !== 'undefined' && typeof window.fetch === 'function' && typeof Audio === 'function'

      useEffect(() => { enabledRef.current = enabled }, [enabled])

      useEffect(() => {
        if (sessionId === undefined) return undefined
        const watcher = createWatcher(uiConversation, () => enabledRef.current)
        watcher.bind(sessionId)
        return () => { watcher.dispose(); stopSpeaking() }
        // Only the Session identity may rebind: the service prop can have a new
        // proxy identity on every render, and rebinding would re-enqueue the
        // settled reply and restart the narration from the beginning.
      }, [sessionId])

      useEffect(() => {
        writeEnabled(enabled)
        if (enabled) resumeSpeaking()
        else pauseSpeaking()
      }, [enabled])

      // The microphone would otherwise record the narration and transcribe the
      // speaker's voice too. The voice-input toolbar publishes its phase on
      // `data-voice-activity`; while it requests or records, the narration
      // pauses, and it continues once the toolbar stops capturing (a dictation
      // longer than the mute window discards it instead).
      useEffect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
        const currentPhase = () => {
          const row = document.querySelector('[data-voice-activity]')
          return row === null ? null : row.getAttribute('data-voice-activity')
        }
        const evaluate = () => {
          const phase = currentPhase()
          if (phase === 'requesting' || phase === 'recording') {
            if (!dictating) {
              dictating = true
              if (!paused) pauseSpeaking()
            }
            return
          }
          if (!dictating) return
          // Drop the interrupted narration as soon as the microphone is free:
          // the user is composing, and making them wait for the mute window
          // could swallow the reply to the message they are about to send.
          stopSpeaking()
          return
        }
        let queued = false
        const schedule = () => {
          if (queued) return
          queued = true
          queueMicrotask(() => { queued = false; evaluate() })
        }
        const touches = (node) => node instanceof Element
          && (node.matches('[data-voice-activity]') || node.querySelector('[data-voice-activity]') !== null)
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === 'attributes') { schedule(); return }
            for (const node of record.addedNodes) if (touches(node)) { schedule(); return }
            for (const node of record.removedNodes) if (touches(node)) { schedule(); return }
          }
        })
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-voice-activity'], subtree: true, childList: true })
        evaluate()
        return () => observer.disconnect()
      }, [])

      if (sessionId === undefined) return null

      const label = !available
        ? 'La lectura en voz alta no está disponible en este navegador'
        : enabled ? 'Silenciar la lectura de las respuestas' : 'Leer en voz alta las respuestas'
      // Same outline family and optical weight as the microphone. Colour alone
      // carries the state, so both icons stay background-free: green speaker
      // with waves while reading, red muted speaker otherwise.
      const speakerBody = h('path', { key: 'body', d: 'M4 9.5v5h3.5L13 19V5L7.5 9.5H4z' })
      const icon = enabled
        ? h('svg', { viewBox: '2 3 20 18', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          speakerBody,
          h('path', { key: 'wave1', d: 'M16.5 8.5a5 5 0 0 1 0 7' }),
          h('path', { key: 'wave2', d: 'M19 6a8.5 8.5 0 0 1 0 12' }))
        : h('svg', { viewBox: '2 3 20 18', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          speakerBody,
          h('path', { key: 'off1', d: 'M16 9.5l5.5 5.5' }),
          h('path', { key: 'off2', d: 'M21.5 9.5L16 15' }))

      const tip = enabled ? 'Silenciar' : 'Leer'
      const button = h('button', {
        type: 'button',
        className: 'dsh-ra-button',
        'aria-label': label,
        'aria-pressed': enabled,
        disabled: !available,
        onMouseDown: (event) => { event.preventDefault() },
        onClick: () => { setEnabled((value) => !value) },
      }, icon)

      // Same hint as the microphone: the shared Tooltip when the loader exposes
      // it, and a local fallback with the same box for older builds.
      const control = SharedTooltip === null
        ? h(React.Fragment, null,
          button,
          h('span', { key: 'dsh-ra-tip', className: 'dsh-ra-tip', role: 'tooltip' }, tip))
        : h(SharedTooltip, { label: tip, side: 'top', portal: true }, button)

      return h(React.Fragment, null,
        h('style', { key: 'dsh-ra-style' }, STYLE),
        h('span', { key: 'dsh-ra-anchor', className: 'dsh-ra-anchor' }, control))
    }

    return {
      inject: ['slots', 'uiConversation'],
      apply(ctx) {
        // Capture the service once: the inject factory runs on every render and
        // a tracker proxy may return a fresh identity each time.
        const conversation = ctx.uiConversation
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'read-aloud',
          order: 20,
          inject: () => ({ uiConversation: conversation }),
        }, ReadAloudToggle))
      },
    }
  },
})
