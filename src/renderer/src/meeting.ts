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
import { startRedux, type LiveSegment, type LiveSession } from './liveCaptions'

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
  stop: () => Promise<MeetingResult>
  cancel: () => Promise<void>
}

async function openSystemAudio(): Promise<MediaStream | null> {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    s.getVideoTracks().forEach((t) => {
      t.stop()
      s.removeTrack(t)
    })
    if (s.getAudioTracks().length === 0) return null
    return s
  } catch (e) {
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
  const mic = await openMic()
  const sys = await openSystemAudio()

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
  ctx.createMediaStreamSource(mic).connect(dest)
  if (sys) ctx.createMediaStreamSource(sys).connect(dest)
  const rec = new MediaRecorder(dest.stream)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
  rec.start(1000)

  const release = (): void => {
    mic.getTracks().forEach((t) => t.stop())
    sys?.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }

  const startedAt = Date.now()
  return {
    hasSystemAudio: !!sys,
    micDevice: mic.getAudioTracks()[0]?.label || 'Microphone',
    systemDevice: sys ? sys.getAudioTracks()[0]?.label || 'Mac audio' : null,
    startedAt,
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
