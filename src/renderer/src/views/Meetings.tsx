import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteEntry, Project } from '../../../shared/types'
import { blobToDataUrl, ipcError, toWav } from '../audio'
import {
  DEFAULT_LABELS,
  loadLabels,
  saveLabels,
  startMeeting,
  toMarkdown,
  type Channel,
  type Meeting,
  type MeetingLine,
  type SpeakerLabels
} from '../meeting'
import MeetingImport from './MeetingImport'

const DEFAULT_FOLDER = 'Meetings'
const FOLDER_KEY = 'inkfish.meeting.folder.v1'

interface Props {
  /** Every indexed note — meetings are the `kind: meeting` ones. */
  notes: NoteEntry[]
  titleOf: (e: { id: string; path: string; title: string }) => string
  onOpenNote: (id: string) => void
  onRefresh: () => void
  onClose: () => void
  /** Tells the shell a capture is running (keeps the page mounted). */
  onRecording: (on: boolean) => void
  notify: (msg: string) => void
}

/** The note a finished capture was written to — editable until you move on. */
interface Saved {
  rel: string
  title: string
  folder: string
  tags: string
  transcript: string
  speakers: string[]
  startedAt: number
  durationSec: number
  audioRel?: string
}

const clock = (sec: number): string => {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mm = String(m).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

const defaultTitle = (d = new Date()): string =>
  `Meeting ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`

const folderOf = (path: string): string => path.split('/').slice(0, -1).join('/')

/**
 * Meetings: live capture of your mic and the Mac's audio (Teams, Zoom, Meet…)
 * as two labelled speakers, transcribed as you go, then saved straight into
 * the vault as its own meeting note that you can title, tag, and file.
 */
export default function Meetings({
  notes, titleOf, onOpenNote, onRefresh, onClose, onRecording, notify
}: Props): React.JSX.Element {
  const [labels, setLabels] = useState<SpeakerLabels>(() => loadLabels())
  const [state, setState] = useState<'idle' | 'starting' | 'rec' | 'saving'>('idle')
  const [lines, setLines] = useState<MeetingLine[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [devices, setDevices] = useState<{ mic: string; system: string | null; error: string } | null>(null)
  const [levels, setLevels] = useState({ mic: 0, system: 0 })
  /** Seconds of call audio heard so far — tells silence from no capture. */
  const heardRef = useRef(0)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [showImport, setShowImport] = useState(false)
  const meetingRef = useRef<Meeting | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    window.api.projects.list().then(setProjects).catch(() => setProjects([]))
  }, [saved])

  useEffect(() => onRecording(state === 'rec' || state === 'starting' || state === 'saving'), [state, onRecording])

  // Elapsed clock while recording.
  useEffect(() => {
    if (state !== 'rec' || !meetingRef.current) return
    const t0 = meetingRef.current.startedAt
    const m = meetingRef.current
    const id = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 500)
    const lv = window.setInterval(() => {
      const l = m.levels()
      if (l.system > 0.02) heardRef.current += 0.1
      setLevels(l)
    }, 100)
    return () => {
      window.clearInterval(id)
      window.clearInterval(lv)
      setLevels({ mic: 0, system: 0 })
    }
  }, [state])

  // Follow the newest words unless you've scrolled up to reread.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [lines])

  const setLabel = (ch: Channel, v: string): void => {
    const next = { ...labels, [ch]: v }
    setLabels(next)
    saveLabels({ mic: next.mic.trim() || DEFAULT_LABELS.mic, system: next.system.trim() || DEFAULT_LABELS.system })
  }
  const label = (ch: Channel): string => labels[ch].trim() || DEFAULT_LABELS[ch]

  const start = async (): Promise<void> => {
    setSaved(null)
    setLines([])
    setElapsed(0)
    stickRef.current = true
    setState('starting')
    try {
      const m = await startMeeting(setLines)
      meetingRef.current = m
      heardRef.current = 0
      setDevices({ mic: m.micDevice, system: m.systemDevice, error: m.systemError })
      setState('rec')
      if (!m.hasSystemAudio)
        notify(`Mic only: ${m.systemError || 'no call audio'}. Allow Inkfish (or your terminal in dev) under Privacy & Security › Screen & System Audio Recording › System Audio Recording Only, then reopen`)
    } catch (e) {
      notify(`Couldn't start: ${ipcError(e)}`)
      setState('idle')
    }
  }

  const write = async (s: Omit<Saved, 'rel'> & { rel?: string }): Promise<string> =>
    window.api.meeting.save({
      title: s.title,
      folder: s.folder,
      tags: s.tags.split(/[,\s]+/).filter(Boolean),
      transcript: s.transcript,
      speakers: s.speakers,
      startedAt: s.startedAt,
      durationSec: s.durationSec,
      audioRel: s.audioRel,
      replaceRel: s.rel
    })

  const stop = async (): Promise<void> => {
    const m = meetingRef.current
    meetingRef.current = null
    if (!m) return
    setState('saving')
    try {
      const r = await m.stop()
      let audioRel: string | undefined
      try {
        audioRel = await window.api.assets.save('meeting.wav', await blobToDataUrl(await toWav(r.audio)))
      } catch (e) {
        console.warn('[meetings] audio save failed', e)
      }
      const speakers = r.hasSystemAudio ? [label('mic'), label('system')] : [label('mic')]
      const draft = {
        title: defaultTitle(new Date(m.startedAt)),
        folder: localStorage.getItem(FOLDER_KEY) || DEFAULT_FOLDER,
        tags: '',
        transcript: toMarkdown(r.lines, { mic: label('mic'), system: label('system') }),
        speakers,
        startedAt: m.startedAt,
        durationSec: r.durationSec,
        audioRel
      }
      // Saved the moment you stop, so nothing is lost; title/folder/tags after.
      const rel = await write(draft)
      setSaved({ ...draft, rel })
      setLines(r.lines)
      onRefresh()
      notify('Meeting saved ✓')
    } catch (e) {
      notify(`Save failed: ${ipcError(e)}`)
    }
    setState('idle')
  }

  const discard = async (): Promise<void> => {
    const m = meetingRef.current
    meetingRef.current = null
    await m?.cancel().catch(() => undefined)
    setLines([])
    setState('idle')
    notify('Meeting discarded')
  }

  const applySaved = async (): Promise<void> => {
    if (!saved) return
    try {
      const rel = await write(saved)
      localStorage.setItem(FOLDER_KEY, saved.folder)
      setSaved({ ...saved, rel })
      onRefresh()
      notify(`Filed under ${saved.folder || '/'} ✓`)
    } catch (e) {
      notify(`Update failed: ${ipcError(e)}`)
    }
  }

  const openSaved = (): void => {
    if (!saved) return
    const rel = saved.rel
    setSaved(null)
    setLines([])
    onOpenNote(rel)
  }

  // Past meetings, newest first.
  const meetings = useMemo(
    () => notes.filter((n) => n.kind === 'meeting').sort((a, b) => b.createdAt - a.createdAt).slice(0, 40),
    [notes]
  )
  const folders = useMemo(() => {
    const s = new Set<string>([DEFAULT_FOLDER, ...projects.map((p) => p.dir)])
    for (const n of meetings) s.add(folderOf(n.path))
    return [...s].filter(Boolean).sort((a, b) => a.localeCompare(b))
  }, [projects, meetings])

  const move = (n: NoteEntry, dest: string): void => {
    window.api.files
      .move(n.path, dest)
      .then(() => {
        onRefresh()
        notify(`Moved → ${dest || '/'}`)
      })
      .catch((e: unknown) => notify(`Move failed: ${ipcError(e)}`))
  }

  const live = state === 'rec' || state === 'starting' || state === 'saving'
  const visible = lines.filter((l) => l.text)

  return (
    <div className="settings-page meetings-page" aria-label="Meetings">
      <div className="row settings-top">
        <div>
          <span className="eyebrow">Capture</span>
          <h2 className="settings-title">Meetings</h2>
          <p className="muted small settings-sub">
            Records your mic and the call audio as two speakers, transcribed live, then files the note.
          </p>
        </div>
        <span className="flex-sp" />
        <button className="btn ghost sm" onClick={onClose} disabled={live}>
          ← Back
        </button>
      </div>

      <section className="meet-rec" aria-label="Recorder">
        <div className="meet-channels">
          {(['mic', 'system'] as Channel[]).map((ch) => {
            const dev = ch === 'mic' ? devices?.mic : devices?.system
            const off = live && ch === 'system' && devices && !devices.system
            return (
              <div key={ch} className={`meet-ch ch-${ch}${off ? ' off' : ''}${state === 'rec' && !off ? ' live' : ''}`}>
                <span className="meet-dot" aria-hidden />
                <input
                  className="meet-label"
                  value={labels[ch]}
                  onChange={(e) => setLabel(ch, e.target.value)}
                  placeholder={DEFAULT_LABELS[ch]}
                  aria-label={ch === 'mic' ? 'Label for your microphone' : 'Label for call audio'}
                  disabled={state === 'saving'}
                />
                <span className="meet-dev muted small" title={off ? devices?.error : dev ?? ''}>
                  {off
                    ? devices?.error || 'not shared'
                    : state === 'rec' && ch === 'system' && elapsed > 8 && heardRef.current < 0.3
                      ? 'connected, but hearing silence'
                      : live && dev
                        ? dev
                        : ch === 'mic'
                          ? 'This Mac · microphone'
                          : 'Call · Mac audio'}
                </span>
                {state === 'rec' && !off && (
                  <span className="meet-level" aria-hidden>
                    <span style={{ transform: `scaleX(${levels[ch]})` }} />
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div className="meet-controls">
          {state === 'rec' ? (
            <>
              <span className="meet-clock" aria-live="off">
                <span className="rec-dot" aria-hidden /> {clock(elapsed)}
              </span>
              <span className="flex-sp" />
              <button className="btn ghost sm" onClick={() => void discard()}>
                Discard
              </button>
              <button className="btn mint" onClick={() => void stop()}>
                Stop &amp; save
              </button>
            </>
          ) : (
            <>
              <span className="muted small">
                {state === 'starting' ? 'Starting…' : state === 'saving' ? 'Saving…' : 'Ready when the call starts'}
              </span>
              <span className="flex-sp" />
              <button className="btn mint" disabled={state !== 'idle'} onClick={() => void start()}>
                Start meeting
              </button>
            </>
          )}
        </div>

        {(live || visible.length > 0) && (
          <div
            ref={scrollRef}
            className="meet-transcript"
            aria-live="polite"
            onScroll={(e) => {
              const el = e.currentTarget
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12
            }}
          >
            {visible.length === 0 ? (
              <p className="muted small">Listening…</p>
            ) : (
              visible.map((l, i) => {
                const head = i === 0 || visible[i - 1]?.who !== l.who
                return (
                  <p key={`${l.who}-${l.start}-${i}`} className={`meet-line ch-${l.who}${l.draft ? ' draft' : ''}`}>
                    {head && <b>{label(l.who)}</b>}
                    {l.text}
                  </p>
                )
              })
            )}
          </div>
        )}

        {saved && state === 'idle' && (
          <div className="meet-saved">
            <label className="field">
              <span>Title</span>
              <input value={saved.title} onChange={(e) => setSaved({ ...saved, title: e.target.value })} />
            </label>
            <div className="row wrap meet-file">
              <label className="field">
                <span>Folder</span>
                <input
                  list="meet-folders"
                  value={saved.folder}
                  onChange={(e) => setSaved({ ...saved, folder: e.target.value })}
                  placeholder={DEFAULT_FOLDER}
                />
                <datalist id="meet-folders">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span>Tags</span>
                <input
                  value={saved.tags}
                  onChange={(e) => setSaved({ ...saved, tags: e.target.value })}
                  placeholder="work, standup"
                />
              </label>
            </div>
            <div className="row end">
              <button className="btn ghost sm" onClick={() => void applySaved()}>
                Update
              </button>
              <button className="btn mint sm" onClick={openSaved}>
                Open note
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="meet-list" aria-label="Past meetings">
        <div className="row">
          <h3 className="meet-h">Recent</h3>
          <span className="flex-sp" />
          <button className="link-btn small" onClick={() => setShowImport(true)}>
            Import transcript or audio…
          </button>
        </div>
        {meetings.length === 0 ? (
          <p className="muted small">No meetings yet.</p>
        ) : (
          <ul>
            {meetings.map((n) => (
              <li key={n.id}>
                <button className="meet-item" onClick={() => onOpenNote(n.id)}>
                  <span className="meet-item-title">{titleOf(n)}</span>
                  <span className="muted small">
                    {new Date(n.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    {n.tags.length > 0 && ` · ${n.tags.map((t) => `#${t}`).join(' ')}`}
                  </span>
                </button>
                <select
                  className="sm meet-move"
                  value={folderOf(n.path)}
                  aria-label="Folder"
                  onChange={(e) => move(n, e.target.value)}
                >
                  {!folders.includes(folderOf(n.path)) && <option value={folderOf(n.path)}>{folderOf(n.path) || '/'}</option>}
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showImport && (
        <MeetingImport onClose={() => setShowImport(false)} onImported={onRefresh} notify={notify} />
      )}
    </div>
  )
}
