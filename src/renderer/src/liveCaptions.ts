/**
 * Live transcription while recording. Parakeet Redux (vocule) streams drafts
 * every ~100 ms and settles a segment after each pause, so when Redux is the
 * chosen engine its settled text *is* the final transcript — no wait after
 * stop. Without Redux downloaded, Moonshine streams a preview instead.
 */
import { loadAudioPrefs } from './audio'
import { isWebReady, moonshineModule } from './webStt'

export const LIVE_ENGINE = 'web-parakeet-redux'

export interface LiveSegment {
  text: string
  start: number
  end: number
}

export interface LiveResult {
  engine: string
  text: string
  segments: LiveSegment[]
}

export interface LiveSession {
  engine: string
  /** Drain pending audio and return the settled transcript. */
  stop: () => Promise<LiveResult>
  cancel: () => Promise<void>
}

/** Redux streaming on a caller-owned stream (mic, or system audio). */
export async function startRedux(
  stream: MediaStream,
  onText: (text: string, settled: LiveSegment[]) => void
): Promise<LiveSession> {
  const { createSpeech } = await import('@karanganesan/vocule')
  const speech = createSpeech()
  let segments: LiveSegment[] = []
  const live = await speech.listen({
    stream,
    onUpdate: (u) => {
      segments = u.segments.map((s) => ({ text: s.text.trim(), start: s.startSeconds, end: s.endSeconds }))
      onText(u.text.trim(), segments)
    },
    onError: (e) => console.warn('[live] redux', e)
  })
  return {
    engine: 'Parakeet Redux · live',
    stop: async () => {
      const text = (await live.stop()).replace(/\s+/g, ' ').trim()
      segments = live.segments.map((s) => ({ text: s.text.trim(), start: s.startSeconds, end: s.endSeconds }))
      speech.dispose()
      return { engine: 'Parakeet Redux · live', text, segments: segments.filter((s) => s.text) }
    },
    cancel: async () => {
      await live.cancel().catch(() => undefined)
      speech.dispose()
    }
  }
}

async function startMoonshine(onText: (text: string) => void): Promise<LiveSession> {
  const { MicTranscriber, Transcriber, ModelArch } = await import('@moonshine-ai/moonshine-wasm')
  const transcriber = await Transcriber.load({
    language: 'en',
    modelArch: ModelArch.SmallStreaming,
    moduleOptions: await moonshineModule()
  })
  const done: string[] = []
  const { inputId } = loadAudioPrefs()
  const mic = new MicTranscriber()
    .useTranscriber(transcriber)
    .audioConstraints(inputId ? { deviceId: { exact: inputId } } : true)
    .onText((t) => onText([...done, t].join(' ').trim()))
    .onLine((l) => {
      done.push(l.text.trim())
      onText(done.join(' '))
    })
  await mic.start()
  const close = async (): Promise<void> => {
    await mic.stop().catch(() => undefined)
    mic.close()
    transcriber.close()
  }
  return {
    engine: 'Moonshine · live',
    stop: async () => {
      await close()
      const text = done.join(' ').trim()
      return { engine: 'Moonshine · live', text, segments: [] }
    },
    cancel: close
  }
}

/** Redux when downloaded (or chosen), else Moonshine preview. */
export function startLive(stream: MediaStream, onText: (text: string) => void): Promise<LiveSession> {
  const { engine } = loadAudioPrefs()
  return engine === LIVE_ENGINE || isWebReady(LIVE_ENGINE) ? startRedux(stream, onText) : startMoonshine(onText)
}
