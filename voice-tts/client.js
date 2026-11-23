/**
 * Browser half of @local/voice-tts: a "read aloud" action in every finalized
 * assistant message's action strip.
 *
 * The text comes from the Chat snapshot the host already assembled, so the
 * plugin never parses DOM. The audio comes from the Host route the companion
 * `index.js` registers; this module only plays the bytes it receives.
 */
window.__ModuleLoader__.load({
  id: '@local/voice-tts',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'voiceTts'

    const DICTIONARIES = {
      ru: {
        speak: 'Озвучить ответ',
        stop: 'Остановить озвучку',
        busy: 'Готовлю голос…',
        failed: 'Не удалось озвучить',
        empty: 'В ответе нет текста для озвучивания',
        voice: 'Голос',
        voiceHint: 'Голос для озвучивания ответов',
      },
      en: {
        speak: 'Read aloud',
        stop: 'Stop reading',
        busy: 'Preparing voice…',
        failed: 'Could not speak',
        empty: 'This reply has no text to read',
        voice: 'Voice',
        voiceHint: 'Voice used to read replies aloud',
      },
    }

    const CSS = `
      .voice-tts-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: calc(28px + var(--dsh-content-font-delta, 0px));
        height: calc(28px + var(--dsh-content-font-delta, 0px));
        padding: 6px;
        border: none;
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-tertiary);
        cursor: pointer;
      }
      .voice-tts-action svg {
        width: calc(15px + var(--dsh-content-font-delta, 0px));
        height: calc(15px + var(--dsh-content-font-delta, 0px));
      }
      @media (hover: hover) {
        .voice-tts-action:hover {
          background: var(--dsw-alias-interactive-bg-hover);
          color: var(--dsw-alias-label-secondary);
        }
      }
      .voice-tts-action:disabled { cursor: default; opacity: 0.4; }
      .voice-tts-action[data-state="error"] { color: var(--dsw-alias-label-secondary); }
      .voice-tts-picker {
        display: inline-flex;
        align-items: center;
        height: calc(28px + var(--dsh-content-font-delta, 0px));
        max-width: 190px;
        padding: 0 6px;
        border: none;
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-tertiary);
        font: inherit;
        font-size: calc(12px + var(--dsh-content-font-delta, 0px));
        cursor: pointer;
      }
      .voice-tts-picker:hover {
        background: var(--dsw-alias-interactive-bg-hover);
        color: var(--dsw-alias-label-secondary);
      }
      .voice-tts-picker:focus-visible {
        outline: 2px solid var(--dsw-alias-border-accent, currentColor);
        outline-offset: 1px;
      }
      .voice-tts-picker option { color: initial; }
    `

    /** Speaker glyph, or a stop square while playing. */
    function Icon({ playing }) {
      if (playing) {
        return h('svg', { viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
          h('rect', { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1.5 }))
      }
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M3.2 6.1h2.1L8.2 3.6v8.8L5.3 9.9H3.2z', fill: 'currentColor' }),
        h('path', {
          d: 'M10.4 5.7a3.3 3.3 0 0 1 0 4.6',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M12.3 4a5.8 5.8 0 0 1 0 8',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }))
    }

    /**
     * Reduce reply Markdown to the prose worth reading aloud: fenced code,
     * image and link targets, emphasis markers and heading hashes are dropped.
     * @param {string} markdown - assistant reply text.
     * @returns {string} speakable prose.
     */
    function speakable(markdown) {
      return String(markdown ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/[*_~`>|]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
    }

    /**
     * Read one finalized assistant reply's prose from the Chat snapshot.
     * @param {object} snapshot - current Chat target snapshot.
     * @param {string} messageId - durable identity of the target message.
     * @returns {string} concatenated text blocks, or an empty string.
     */
    function replyText(snapshot, messageId) {
      if (snapshot === undefined || snapshot === null) return ''
      const order = snapshot.order
      if (!Array.isArray(order)) return ''
      for (let index = order.length - 1; index >= 0; index--) {
        const node = snapshot.nodes.get(order[index])
        if (node === undefined || node === null) continue
        if (node.kind !== 'assistant-step') continue
        const data = node.data
        if (data === undefined || data === null) continue
        const finalNode = data.finalNode
        if (finalNode === undefined || finalNode.messageId !== messageId) continue
        return (data.blocks ?? [])
          .filter((block) => block !== undefined && block.kind === 'text')
          .map((block) => block.text)
          .join('\n')
      }
      return ''
    }

    /**
     * Shared voice choice: one fetch of `/state` for the whole page, and a
     * single writer that every mounted control reuses.
     */
    const voiceStore = {
      state: null,
      listeners: new Set(),
      loading: null,
      get() { return voiceStore.state },
      subscribe(listener) {
        voiceStore.listeners.add(listener)
        return () => { voiceStore.listeners.delete(listener) }
      },
      emit() { for (const listener of voiceStore.listeners) listener() },
      async load() {
        if (voiceStore.state !== null) return voiceStore.state
        if (voiceStore.loading !== null) return voiceStore.loading
        voiceStore.loading = fetch('/api/voice-tts/state')
          .then(async (response) => {
            if (!response.ok) throw new Error(`state ${response.status}`)
            const body = await response.json()
            voiceStore.state = body
            voiceStore.emit()
            return body
          })
          .catch((error) => {
            console.warn('[voice-tts] could not read voice state', error)
            return null
          })
          .finally(() => { voiceStore.loading = null })
        return voiceStore.loading
      },
      async choose(voice) {
        const previous = voiceStore.state
        if (previous !== null) {
          voiceStore.state = { ...previous, voice }
          voiceStore.emit()
        }
        try {
          const response = await fetch('/api/voice-tts/voice', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ voice }),
          })
          if (!response.ok) throw new Error(`voice ${response.status}`)
        } catch (error) {
          console.warn('[voice-tts] could not save the voice choice', error)
          if (previous !== null) {
            voiceStore.state = previous
            voiceStore.emit()
          }
        }
      },
    }

    /** Subscribe a component to the shared voice state. */
    function useVoiceState() {
      const [value, setValue] = React.useState(voiceStore.get())
      React.useEffect(() => {
        let alive = true
        const unsubscribe = voiceStore.subscribe(() => { if (alive) setValue(voiceStore.get()) })
        void voiceStore.load()
        return () => { alive = false; unsubscribe() }
      }, [])
      return value
    }

    /**
     * One message's read-aloud control.
     * @param {object} props - owner `messageId`, the `useChat` selector hook,
     * the injected verbs, and the locale `t`.
     */
    function VoiceAction(props) {
      const { messageId, useChat, t } = props
      const [state, setState] = React.useState('idle')
      const audioRef = React.useRef(null)
      const aliveRef = React.useRef(true)
      // The Chat snapshot hook arrives as a standard session prop. Fall back to
      // a constant reader when a composition does not supply it, so the button
      // degrades to "nothing to read" instead of crashing the action strip.
      const readChat = typeof useChat === 'function' ? useChat : (selector) => selector(undefined)
      // Subscribe to just this message's prose: unchanged replies do not re-render.
      const text = readChat((snapshot) => replyText(snapshot, messageId))

      const release = React.useCallback(() => {
        const audio = audioRef.current
        if (audio !== null) {
          audio.pause()
          audioRef.current = null
          if (audio.dataset?.url !== undefined) URL.revokeObjectURL(audio.dataset.url)
        }
      }, [])

      React.useEffect(() => () => {
        aliveRef.current = false
        release()
      }, [release])

      const onClick = React.useCallback(async () => {
        if (audioRef.current !== null) {
          release()
          setState('idle')
          return
        }
        const plain = speakable(text)
        if (plain === '') {
          setState('empty')
          return
        }
        setState('busy')
        try {
          const response = await fetch('/api/voice-tts/speak', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: plain }),
          })
          if (!response.ok) {
            console.warn('[voice-tts]', response.status, await response.text().catch(() => ''))
            if (aliveRef.current) setState('error')
            return
          }
          // The engine decides the media type: neural speech is MP3, the
          // offline fallback is WAV. Name it so the browser prefers the right
          // decoder instead of sniffing the blob.
          const engine = response.headers.get('x-voice-tts-engine') === 'sapi' ? 'wav' : 'mp3'
          const bytes = await response.blob()
          const url = URL.createObjectURL(bytes.slice(0, bytes.size, `audio/${engine}`))
          if (!aliveRef.current) { URL.revokeObjectURL(url); return }
          const player = new Audio(url)
          player.dataset.url = url
          audioRef.current = player
          player.addEventListener('ended', () => {
            if (audioRef.current === player) {
              audioRef.current = null
              URL.revokeObjectURL(url)
            }
            if (aliveRef.current) setState('idle')
          })
          player.addEventListener('error', () => {
            if (audioRef.current === player) {
              audioRef.current = null
              URL.revokeObjectURL(url)
            }
            if (aliveRef.current) setState('error')
          })
          setState('playing')
          await player.play()
        } catch (error) {
          console.warn('[voice-tts] playback failed', error)
          if (aliveRef.current) setState('error')
        }
      }, [release, text])

      const label = state === 'playing' ? t('stop')
        : state === 'busy' ? t('busy')
          : state === 'error' ? t('failed')
            : state === 'empty' ? t('empty')
              : t('speak')

      return h('button', {
        type: 'button',
        className: 'voice-tts-action',
        'aria-label': label,
        title: label,
        'data-state': state === 'idle' ? undefined : state,
        disabled: state === 'busy',
        onClick,
      }, h(Icon, { playing: state === 'playing' }))
    }

    /**
     * Voice picker for the header utilities: a native select, so keyboard use,
     * the option list and the platform popup all come from the browser.
     * @param {object} props - the locale `t`.
     */
    function VoicePicker({ t }) {
      const state = useVoiceState()
      if (state === null) return null
      const voices = Array.isArray(state.voices) ? state.voices : []
      if (voices.length === 0) return null
      const current = state.voice ?? voices[0].id
      return h('label', { className: 'voice-tts-picker', title: t('voiceHint') },
        h('span', { 'aria-hidden': true, style: { marginRight: 4 } }, '🔊'),
        h('select', {
          'aria-label': t('voice'),
          title: t('voiceHint'),
          value: current,
          onChange: (event) => { void voiceStore.choose(event.target.value) },
          style: {
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
            maxWidth: 160,
          },
        }, voices.map((voice) => h('option', { key: voice.id, value: voice.id }, voice.name))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'voice-tts: dictionaries')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'voice-tts: styles')

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'voice-tts',
          order: 20,
          locale: NS,
        }, VoiceAction))

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'voice-tts-voice',
          order: 15,
          locale: NS,
        }, VoicePicker))
      },
    }
  },
})
