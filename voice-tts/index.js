/**
 * Host half of @local/voice-tts: turns agent reply text into audio the browser
 * can play, and serves it on an authenticated route.
 *
 * Two engines are available:
 *
 * - `neural` (default) uses edge-tts, the Microsoft neural voices Edge itself
 *   reads pages with. They sound human; they need the network.
 * - `sapi` uses the Windows System.Speech synthesizer. It works offline but
 *   sounds robotic, because the desktop voices are the old concatenative ones.
 *
 * The route is registered through the `connection` service rather than the bare
 * webserver, so it inherits the browser trust fence (loopback Host, matching
 * Origin, signed session cookie) every other browser-facing endpoint uses.
 *
 * @module @local/voice-tts
 */

import { spawn, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdtemp, appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Route the browser fetches synthesized audio from. It lives under `/api`
 * because the connection's exact Fetch registry only accepts routes on that
 * channel, which is also what puts them behind the browser trust fence.
 */
export const TTS_PATH = '/api/voice-tts/speak'

/** Route returning the selectable voices and the current choice. */
export const STATE_PATH = '/api/voice-tts/state'

/** Route changing the chosen voice. */
export const VOICE_PATH = '/api/voice-tts/voice'

/** Directory holding this plugin's files. */
const HERE = dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  /** `neural` (natural, online) or `sapi` (robotic, offline). */
  engine: 'neural',
  /** edge-tts voice name, used by the neural engine. */
  voice: 'ru-RU-SvetlanaNeural',
  /** Rate offset in percent, neural engine (-50..100). */
  rate: 0,
  /** Pitch offset in Hz, neural engine (-100..100). */
  pitch: 0,
  /** Volume offset in percent, neural engine (-100..100). */
  volumeOffset: 0,
  /** Windows voice name, used by the SAPI engine. */
  sapiVoice: 'Microsoft Irina Desktop',
  /** SAPI rate, -10..10. */
  sapiRate: 0,
  /** Fall back to SAPI when the neural request fails (offline, outage). */
  fallbackToSapi: true,
  /** Python interpreter running edge-tts; resolved from the DSH runtime. */
  pythonPath: '',
  timeoutMs: 45000,
}

/** Longest reply we are willing to synthesize, in characters. */
const HARD_MAX_CHARS = 20000

export const name = 'voice-tts'
export const inject = ['connection']

/**
 * Register the speech route.
 * @param ctx - owning Host context.
 * @param config - optional overrides from cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  // The chosen voice is a per-user preference, so it lives beside the profile
  // rather than in the shared patch layer.
  const store = createVoiceStore(ctx)

  ctx.connection.fetch.register({
    path: TTS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => speak(settings, request, store),
  })

  ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const current = await store.read()
      return Response.json({
        voices: VOICES,
        voice: current ?? settings.voice,
        engine: settings.engine,
        offlineVoice: settings.sapiVoice,
      }, { headers: { 'cache-control': 'no-store' } })
    },
  })

  ctx.connection.fetch.register({
    path: VOICE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let voice
      try {
        const body = await request.json()
        voice = typeof body?.voice === 'string' ? body.voice : ''
      } catch {
        return new Response('invalid JSON body', { status: 400 })
      }
      if (!VOICES.some((candidate) => candidate.id === voice)) {
        log('rejected unknown voice', voice)
        return new Response('unknown voice', { status: 400 })
      }
      const stored = await store.write(voice)
      console.log(`[voice-tts] voice set to ${voice} (written=${String(stored)})`)
      return Response.json({ ok: true, voice, written: stored })
    },
  })
}

/**
 * Voices offered in the picker. `ru` names the Russian word for the gender so
 * the menu reads naturally without a translation table per locale.
 */
export const VOICES = [
  { id: 'ru-RU-SvetlanaNeural', name: 'Светлана', gender: 'female', engine: 'neural' },
  { id: 'ru-RU-DmitryNeural', name: 'Дмитрий', gender: 'male', engine: 'neural' },
  { id: 'sapi', name: 'Irina (Windows, офлайн)', gender: 'female', engine: 'sapi' },
]

/**
 * Persistent per-user choice of voice.
 * @param ctx - owning Host context, used for the data directory.
 */
function createVoiceStore(ctx) {
  const file = join(preferenceDir(), 'voice-tts.json')

  return {
    /** @returns the resolved preference file path. */
    location: () => file,
    /** @returns the stored voice id, or undefined when nothing is stored. */
    async read() {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        return typeof parsed?.voice === 'string' ? parsed.voice : undefined
      } catch {
        return undefined
      }
    },
    /** @param voice - voice id to persist. @returns whether the file was written. */
    async write(voice) {
      try {
        await writeFile(file, JSON.stringify({ voice }, null, 2), 'utf8')
        return true
      } catch (error) {
        log(`could not persist the voice choice to ${file}`, error)
        return false
      }
    },
  }
}

/**
 * Directory holding this plugin's per-user state.
 *
 * The desktop launcher passes the profile directory on its command line but
 * does not export DSH_HOME to the Host process, so the profile named there wins
 * over the environment; a preference must not depend on which of the two is
 * present.
 */
function preferenceDir() {
  for (const arg of process.argv.slice(1)) {
    if (/[\\/]profiles[\\/][^\\/]+$/.test(arg)) return arg
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return home
  return tmpdir()
}

/** Append one diagnostic line the user can send back after reproducing an issue. */
async function trace(line) {
  try {
    await appendFile(join(preferenceDir(), 'voice-tts.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* diagnostics must never fail a request */ }
}

/**
 * Answer one synthesis request with audio bytes.
 * @param settings - resolved configuration.
 * @param request - browser request carrying `{ text }` as JSON.
 * @returns the audio response, or a plain-text failure.
 */
async function speak(settings, request, store) {
  const started = Date.now()

  let text
  try {
    const body = await request.json()
    text = typeof body?.text === 'string' ? body.text.trim() : ''
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }

  if (text === '') return new Response('empty text', { status: 400 })

  const limit = Math.min(Number(settings.maxChars) || HARD_MAX_CHARS, HARD_MAX_CHARS)
  if (text.length > limit) text = `${text.slice(0, limit)}…`

  const chosen = await store.read()
  let audio = await render(settings, text, chosen)
  if (audio === undefined) {
    await trace(`speak FAILED chosen=${String(chosen)} python=${String(pythonOf(settings))}`)
    return new Response('speech synthesis failed', { status: 500 })
  }
  await trace(`speak ok chosen=${String(chosen)} engine=${audio.engine} voice=${audio.voice} bytes=${audio.bytes.length}`)

  return new Response(audio.bytes, {
    status: 200,
    headers: {
      'content-type': audio.mime,
      'content-length': String(audio.bytes.length),
      'cache-control': 'no-store',
      'x-voice-tts-engine': audio.engine,
      'x-voice-tts-voice': audio.voice,
      'x-voice-tts-ms': String(Date.now() - started),
    },
  })
}

/**
 * Render one phrase with the configured engine, falling back to SAPI.
 * @param settings - resolved configuration.
 * @param text - phrase to speak.
 * @returns bytes and media type, or undefined when every engine failed.
 */
async function render(settings, text, chosen) {
  // An explicitly chosen voice wins over the configured default.
  if (chosen === 'sapi') {
    return sapiResult(settings, text)
  }

  const voice = chosen ?? settings.voice
  const engine = settings.engine === 'sapi' ? 'sapi' : 'neural'

  if (engine === 'neural') {
    try {
      return {
        bytes: await synthesizeNeural({ ...settings, voice }, text),
        mime: 'audio/mpeg',
        engine: 'neural',
        voice,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`neural synthesis failed for ${voice}`, error)
      await trace(`neural FAILED voice=${voice} python=${String(pythonOf(settings))} error=${message}`)
      if (settings.fallbackToSapi !== true) return undefined
    }
  }

  return sapiResult(settings, text)
}

/**
 * Render with the offline Windows engine.
 * @param settings - resolved configuration.
 * @param text - phrase to speak.
 * @returns bytes, media type and the voice actually used, or undefined on failure.
 */
async function sapiResult(settings, text) {
  try {
    return {
      bytes: await synthesizeSapi(settings, text),
      mime: 'audio/wav',
      engine: 'sapi',
      voice: String(settings.sapiVoice ?? DEFAULTS.sapiVoice),
    }
  } catch (error) {
    log('SAPI synthesis failed', error)
    return undefined
  }
}

/** Report a failure without assuming a particular logger shape. */
function log(message, error) {
  console.warn(`[voice-tts] ${message}:`, error instanceof Error ? error.message : error)
}

/** Format a signed offset the way edge-tts expects it: `+10%`, `-10%`, `+0Hz`. */
function signed(value, unit) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0
  return `${number >= 0 ? '+' : ''}${number}${unit}`
}

/**
 * Locate the Python interpreter that carries edge-tts.
 *
 * More than one interpreter is installed, and only the per-user runtime has
 * edge-tts in it. Existence alone is therefore not enough: each candidate is
 * asked whether it can import the module, and the first one that can wins. The
 * probes are cached because they cost a process launch each.
 *
 * @param settings - resolved configuration; an explicit path wins.
 * @returns the working interpreter path, or undefined when none is found.
 */
function pythonOf(settings) {
  if (typeof settings.pythonPath === 'string' && settings.pythonPath !== '') return settings.pythonPath
  if (pythonProbe !== undefined) return pythonProbe
  pythonProbe = null

  for (const candidate of pythonCandidates()) {
    if (!entryExists(candidate)) continue
    if (canImportEdgeTts(candidate)) {
      pythonProbe = candidate
      return candidate
    }
  }
  return undefined
}

/** Memoized result of the interpreter search; undefined until first probe. */
let pythonProbe

/**
 * Ask one interpreter whether `edge_tts` imports, synchronously.
 * @param python - interpreter path.
 * @returns whether the import succeeds.
 */
function canImportEdgeTts(python) {
  try {
    const result = spawnSync(python, ['-c', 'import edge_tts'], {
      windowsHide: true,
      timeout: 15000,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Test one path for existence without pattern interpretation.
 * @param target - absolute file path.
 * @returns whether the entry exists.
 */
function entryExists(target) {
  const dir = dirname(target)
  const base = target.slice(dir.length + 1)
  try {
    return readdirSync(dir).includes(base)
  } catch {
    return false
  }
}

/** Ordered interpreter candidates, most specific first. */
function pythonCandidates() {
  const candidates = []

  // 1. The per-user runtime comes first: it is the one that carries the
  //    third-party packages, because installs there need no elevation.
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    candidates.push(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  }
  const profile = process.env.USERPROFILE ?? process.env.HOME
  if (typeof profile === 'string' && profile !== '') {
    candidates.push(join(profile, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  }

  // 2. The runtime shipped with the application.
  for (const arg of process.argv.slice(1)) {
    if (/primary-runtime$/i.test(arg)) {
      candidates.push(join(arg, 'dependencies', 'python', 'python.exe'))
    }
  }
  const execDir = dirname(process.execPath)
  candidates.push(join(execDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'))

  return [...new Set(candidates)]
}

/**
 * Synthesize with edge-tts.
 * @param settings - resolved configuration.
 * @param text - phrase to speak.
 * @returns MP3 bytes.
 */
export async function synthesizeNeural(settings, text) {
  const python = pythonOf(settings)
  if (python === undefined) throw new Error('no Python interpreter configured for the neural engine')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-tts-'))
  try {
    const textPath = join(dir, 'text.txt')
    const outPath = join(dir, 'speech.mp3')
    // The phrase travels through a UTF-8 file so quoting, markup and newlines
    // can never change the command line.
    await writeFile(textPath, text, 'utf8')

    await run(python, [
      join(HERE, 'tts_edge.py'),
      '--text-file', textPath,
      '--out', outPath,
      '--voice', String(settings.voice ?? DEFAULTS.voice),
      '--rate', signed(settings.rate, '%'),
      '--volume', signed(settings.volumeOffset, '%'),
      '--pitch', signed(settings.pitch, 'Hz'),
    ], settings.timeoutMs ?? DEFAULTS.timeoutMs)

    return await readFile(outPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Synthesize with the Windows System.Speech synthesizer.
 * @param settings - resolved configuration.
 * @param text - phrase to speak.
 * @returns WAV bytes.
 */
export async function synthesizeSapi(settings, text) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-tts-'))
  try {
    const textPath = join(dir, 'text.txt')
    const wavPath = join(dir, 'speech.wav')
    await writeFile(textPath, text, 'utf8')

    const quote = (value) => String(value).replace(/'/g, "''")
    const script = [
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Speech',
      `$text = [System.IO.File]::ReadAllText('${quote(textPath)}', [System.Text.Encoding]::UTF8)`,
      '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$voice = '${quote(settings.sapiVoice ?? DEFAULTS.sapiVoice)}'`,
      'if ($voice) { try { $synth.SelectVoice($voice) } catch { } }',
      `$synth.Rate = ${clamp(settings.sapiRate, -10, 10)}`,
      '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
      `$synth.SetOutputToWaveFile('${quote(wavPath)}', $fmt)`,
      '$synth.Speak($text)',
      '$synth.Dispose()',
    ].join('\n')

    const scriptPath = join(dir, 'speak.ps1')
    await writeFile(scriptPath, script, 'utf8')

    await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], settings.timeoutMs ?? DEFAULTS.timeoutMs)

    return await readFile(wavPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Clamp an integer into an inclusive range. */
function clamp(value, min, max) {
  const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0
  return Math.max(min, Math.min(max, number))
}

/**
 * Run one host command to completion.
 * @param file - executable path or name.
 * @param args - argument list.
 * @param timeoutMs - deadline in milliseconds.
 */
function run(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error('speech synthesis timed out'))
    }, timeoutMs)
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => {
      if (code === 0) finish(resolve, undefined)
      else finish(reject, new Error(`synthesis command exited with ${code}: ${stderr.trim().slice(-400)}`))
    })
  })
}
