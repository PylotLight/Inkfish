/**
 * Meeting capture: your mic and the Mac's output (Teams, Zoom, Meet…) as two
 * separate streams, each transcribed live by Parakeet Redux, then interleaved
 * by time. Each side is a channel ('mic' = this Mac, 'system' = the call) with
 * an editable speaker label (default "Me" / "Remote"). Both are mixed into one
 * recording for the note.
 *
 * System audio comes from getDisplayMedia + loopback (ScreenCaptureKit under
 * the hood, macOS 13+); the main process grants it and needs Screen Recording
 * permission. Video is dropped immediately.
 */
import { openMic } from './audio'
import { liveAvailable, startRedux, type LiveSegment, type LiveSession } from './liveCaptions'

export type Channel = 'mic' | 'system'

export interface MeetingLine {
  who: Channel
  text: string
  start: number
  /** Still being spoken (live draft, not settled yet). */
  draft?: boolean
}

export type SpeakerLabels = Record<Channel, string>

const LABELS_KEY = 'inkfish.meeting.labels.v1'
export const DEFAULT_LABELS: SpeakerLabels = { mic: 'Me', system: 'Remote' }

export function loadLabels(): SpeakerLabels {
  try {
    const raw = JSON.parse(localStorage.getItem(LABELS_KEY) ?? '{}') as Partial<SpeakerLabels>
    return {
      mic: raw.mic?.trim() || DEFAULT_LABELS.mic,
      system: raw.system?.trim() || DEFAULT_LABELS.system
    }
  } catch {
    return { ...DEFAULT_LABELS }
  }
}

export function saveLabels(l: SpeakerLabels): void {
  try {
    localStorage.setItem(LABELS_KEY, JSON.stringify(l))
  } catch {
    // ignore
  }
}

export interface MeetingResult {
  lines: MeetingLine[]
  audio: Blob
  hasSystemAudio: boolean
  durationSec: number
}

export interface Meeting {
  hasSystemAudio: boolean
  /** Input device names, for the channel chips ("MacBook Pro Microphone"). */
  micDevice: string
  systemDevice: string | null
  startedAt: number
  /** Why the call side is missing ('' when captured). */
  systemError: string
  /** Current input level per channel, 0–1, for the meters. */
  levels: () => { mic: number; system: number }
  stop: () => Promise<MeetingResult>
  cancel: () => Promise<void>
}

/** Why the call side isn't being captured, for the UI ('' when it is). */
export let systemAudioError = ''

/**
 * The call side. Keep the (tiny) video track alive but disabled: on macOS,
 * stopping it ends the ScreenCaptureKit stream and the loopback audio goes
 * silent with it. Callers get an audio-only stream; `stopAll` ends both.
 */
/**
 * Preferred path: audio-only Core Audio tap from the helper (macOS 14.2+),
 * PCM over IPC, replayed into a MediaStream. No screen permission involved.
 */
async function openTapAudio(): Promise<{ audio: MediaStream; stopAll: () => void; label: string } | null> {
  const api = window.api.systap
  const r = await api.start().catch((e: unknown) => ({ error: String(e) }))
  if ('error' in r) {
    systemAudioError = r.error
    console.warn('[meeting] tap unavailable:', r.error)
    return null
  }
  const ctx = new AudioContext({ sampleRate: r.rate })
  const queue: Float32Array[] = []
  let head = 0
  let queued = 0
  const offData = api.onData((pcm) => {
    queue.push(pcm)
    queued += pcm.length
    // Cap latency at ~1 s: drop the oldest audio if the renderer falls behind.
    while (queued > r.rate && queue.length > 1) {
      const old = queue.shift() as Float32Array
      queued -= old.length - head
      head = 0
    }
  })
  const node = ctx.createScriptProcessor(2048, 0, 1)
  node.onaudioprocess = (ev) => {
    const out = ev.outputBuffer.getChannelData(0)
    let i = 0
    while (i < out.length && queue.length > 0) {
      const cur = queue[0] as Float32Array
      const n = Math.min(out.length - i, cur.length - head)
      out.set(cur.subarray(head, head + n), i)
      i += n
      head += n
      queued -= n
      if (head >= cur.length) {
        queue.shift()
        head = 0
      }
    }
    out.fill(0, i)
  }
  const dest = ctx.createMediaStreamDestination()
  node.connect(dest)
  await ctx.resume()
  return {
    audio: dest.stream,
    label: 'Mac audio (system tap)',
    stopAll: () => {
      offData()
      node.disconnect()
      void ctx.close()
      void api.stop()
    }
  }
}

async function openSystemAudio(): Promise<{ audio: MediaStream; stopAll: () => void; label?: string } | null> {
  systemAudioError = ''
  const tap = await openTapAudio()
  if (tap) return tap
  const tapError = systemAudioError
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 2, height: 2, frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
    s.getVideoTracks().forEach((t) => (t.enabled = false))
    const tracks = s.getAudioTracks()
    if (tracks.length === 0) {
      systemAudioError = 'no system audio track (needs macOS 13+)'
      s.getTracks().forEach((t) => t.stop())
      return null
    }
    tracks.forEach((t) => {
      t.onended = () => console.warn('[meeting] system audio track ended')
    })
    return { audio: new MediaStream(tracks), stopAll: () => s.getTracks().forEach((t) => t.stop()) }
  } catch (e) {
    const name = e instanceof DOMException ? e.name : ''
    systemAudioError =
      tapError ||
      (name === 'NotAllowedError'
        ? 'Screen & System Audio Recording permission is off'
        : e instanceof Error
          ? e.message
          : String(e))
    console.warn('[meeting] system audio unavailable', e)
    return null
  }
}

const merge = (me: LiveSegment[], them: LiveSegment[]): MeetingLine[] =>
  [
    ...me.map((s) => ({ who: 'mic' as const, text: s.text, start: s.start })),
    ...them.map((s) => ({ who: 'system' as const, text: s.text, start: s.start }))
  ]
    .filter((l) => l.text)
    .sort((a, b) => a.start - b.start)

const stamp = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

export function toMarkdown(lines: MeetingLine[], labels: SpeakerLabels = loadLabels()): string {
  // Consecutive lines from the same side fold into one paragraph.
  const out: string[] = []
  let last: MeetingLine | null = null
  for (const l of lines) {
    if (last && last.who === l.who) out[out.length - 1] += ` ${l.text}`
    else out.push(`**${labels[l.who]}** (${stamp(l.start)}): ${l.text}`)
    last = l
  }
  return out.join('\n\n')
}

export async function startMeeting(onLines: (lines: MeetingLine[]) => void): Promise<Meeting> {
  if (!liveAvailable()) {
    throw new Error('Download Parakeet Redux · Web in Settings › Voice for live meeting text')
  }
  const mic = await openMic()
  const sysCap = await openSystemAudio()
  const sys = sysCap?.audio ?? null

  // Live view: settled segments from both sides plus each side's draft.
  let meSeg: LiveSegment[] = []
  let themSeg: LiveSegment[] = []
  const t0 = performance.now()
  const draft = { me: '', them: '' }
  const push = (): void => {
    const lines = merge(meSeg, themSeg)
    const now = (performance.now() - t0) / 1000
    if (draft.me) lines.push({ who: 'mic', text: draft.me, start: now, draft: true })
    if (draft.them) lines.push({ who: 'system', text: draft.them, start: now, draft: true })
    onLines(lines)
  }
  const track = (side: 'me' | 'them') => (text: string, settled: LiveSegment[]) => {
    if (side === 'me') meSeg = settled
    else themSeg = settled
    const done = settled.map((s) => s.text).join(' ')
    draft[side] = text.slice(done.length).trim()
    push()
  }

  const sessions: LiveSession[] = [await startRedux(mic, track('me'))]
  if (sys) sessions.push(await startRedux(sys, track('them'), false))

  // One mixed recording for the note's audio attachment.
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  const meter = (stream: MediaStream): AnalyserNode => {
    const a = ctx.createAnalyser()
    a.fftSize = 512
    const src = ctx.createMediaStreamSource(stream)
    src.connect(dest)
    src.connect(a)
    return a
  }
  const micMeter = meter(mic)
  const sysMeter = sys ? meter(sys) : null
  const buf = new Float32Array(512)
  const rms = (a: AnalyserNode | null): number => {
    if (!a) return 0
    a.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    return Math.min(1, Math.sqrt(sum / buf.length) * 4)
  }
  const rec = new MediaRecorder(dest.stream)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
  rec.start(1000)

  const release = (): void => {
    mic.getTracks().forEach((t) => t.stop())
    sysCap?.stopAll()
    void ctx.close()
  }

  const startedAt = Date.now()
  return {
    hasSystemAudio: !!sys,
    micDevice: mic.getAudioTracks()[0]?.label || 'Microphone',
    systemDevice: sys ? sysCap?.label || sys.getAudioTracks()[0]?.label || 'Mac audio' : null,
    startedAt,
    systemError: systemAudioError,
    levels: () => ({ mic: rms(micMeter), system: rms(sysMeter) }),
    stop: async () => {
      const recorded = new Promise<Blob>((res) => {
        rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType }))
      })
      rec.stop()
      const [me, them] = await Promise.all(sessions.map((s) => s.stop()))
      release()
      const lines = merge(me?.segments ?? [], them?.segments ?? [])
      return {
        lines,
        audio: await recorded,
        hasSystemAudio: !!sys,
        durationSec: (performance.now() - t0) / 1000
      }
    },
    cancel: async () => {
      rec.stop()
      await Promise.all(sessions.map((s) => s.cancel()))
      release()
    }
  }
}
