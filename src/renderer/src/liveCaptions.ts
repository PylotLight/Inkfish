/**
 * Live transcription while recording. Parakeet Redux (vocule) streams drafts
 * every ~100 ms and settles a segment after each pause, so when Redux is the
 * chosen engine its settled text *is* the final transcript — no wait after
 * stop. Live text needs Redux · Web downloaded.
 */
import { isWebReady, reduxSpeech, resetWeb } from './webStt'

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
  onText: (text: string, settled: LiveSegment[]) => void,
  /** Use the warm shared instance; a concurrent second stream needs its own. */
  shared = true
): Promise<LiveSession> {
  const open = async (useShared: boolean): Promise<LiveSession> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const speech: any = useShared
      ? await reduxSpeech()
      : await (await import('@karanganesan/vocule')).createSpeech()
    const release = (): void => {
      if (!useShared) speech.dispose()
    }
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
        release()
        return { engine: 'Parakeet Redux · live', text, segments: segments.filter((s) => s.text) }
      },
      cancel: async () => {
        await live.cancel().catch(() => undefined)
        release()
      }
    }
  }
  if (!shared) return open(false)
  try {
    return await open(true)
  } catch (err) {
    // The shared instance can wedge (e.g. a benchmark timeout disposes it
    // mid-flight) — drop it and retry once on a fresh instance instead of
    // silently losing live text for every recording after.
    console.warn('[live] shared redux failed, retrying with a fresh instance:', err)
    resetWeb(LIVE_ENGINE)
    return open(false)
  }
}

/** Live text runs on Redux · Web; without it downloaded there's no preview. */
export const liveAvailable = (): boolean => isWebReady(LIVE_ENGINE)

export function startLive(stream: MediaStream, onText: (text: string) => void): Promise<LiveSession> {
  if (!liveAvailable()) return Promise.reject(new Error('Download Parakeet Redux · Web for live text'))
  return startRedux(stream, onText)
}
