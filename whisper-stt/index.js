/** Local whisper.cpp speech-to-text provider. Adds Russian recognition to the voice input. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'whisper-stt'
export const inject = ['speechToText']

const DEFAULTS = {
  binaryPath: 'D:\\AI\\whisper\\bin\\Release\\whisper-cli.exe',
  modelPath: 'D:\\AI\\whisper\\models\\ggml-small.bin',
  threads: 4,
  timeoutMs: 180000,
}

const LANGUAGES = ['auto', 'ru', 'en', 'uk', 'de', 'fr', 'es', 'it', 'pl']

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  ctx.effect(() => ctx.speechToText.register({
    info: {
      id: 'whisper-local',
      name: 'Whisper (локальный)',
      location: 'host-local',
      languages: LANGUAGES,
    },
    transcribe: (input, signal) => transcribe(settings, input, signal),
  }))
}

async function transcribe(settings, input, signal) {
  const started = Date.now()
  signal?.throwIfAborted?.()
  const audio = Buffer.from(input.audio)
  const seconds = waveDuration(audio)

  const dir = await mkdtemp(join(tmpdir(), 'dsh-whisper-'))
  try {
    const audioPath = join(dir, 'audio.wav')
    const outBase = join(dir, 'transcript')
    await writeFile(audioPath, audio)

    const language = input.language && input.language !== 'auto' ? input.language : 'auto'
    const args = [
      '-m', settings.modelPath,
      '-f', audioPath,
      '-l', language,
      '-otxt',
      '-of', outBase,
      '-nt', '-np',
      '-t', String(settings.threads ?? 4),
    ]
    await run(settings.binaryPath, args, signal, settings.timeoutMs ?? 180000)
    const text = clean(await readFile(`${outBase}.txt`, 'utf8'))
    return { text, audioSeconds: seconds, inferenceSeconds: (Date.now() - started) / 1000 }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function run(binary, args, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: dirname(binary), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk.toString('utf8') })
    const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); fn(value) }
    const onAbort = () => { child.kill(); finish(reject, new Error('Transcription cancelled')) }
    const timer = setTimeout(() => { child.kill(); finish(reject, new Error('Whisper timed out')) }, timeoutMs)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => {
      if (code === 0) finish(resolve, undefined)
      else finish(reject, new Error(`whisper-cli exited with ${code}: ${stderr.trim().slice(-500)}`))
    })
  })
}

function clean(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[(BLANK_AUDIO|MUSIC|SOUND|SILENCE)\]$/i.test(line))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Read the data-chunk duration of a RIFF/WAVE recording; throws when the input is not WAV. */
function waveDuration(buffer) {
  if (buffer.length < 44) throw new Error('Audio is not a WAV file')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Audio is not a RIFF/WAVE file')
  }
  let offset = 12
  let sampleRate = 0
  let blockAlign = 0
  let dataSize = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      sampleRate = buffer.readUInt32LE(body + 4)
      blockAlign = buffer.readUInt16LE(body + 12)
    } else if (id === 'data') {
      dataSize = Math.min(size, buffer.length - body)
      break
    }
    offset = body + size + (size % 2)
  }
  if (!sampleRate || !blockAlign) throw new Error('WAV file has no fmt chunk')
  return dataSize / blockAlign / sampleRate
}
