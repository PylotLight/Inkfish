import { useEffect, useRef, useState } from 'react'
import type { NoteKind, Project } from '../../../shared/types'
import { blobToDataUrl, openMic, toWav } from '../audio'

/**
 * Capture popover (380×300): one borderless composer on the window's own
 * vibrancy — no nested cards. Type, and/or drop/paste an
 * image, and/or dictate — everything lands in the same box, Cmd-Enter saves.
 */
export default function Capture(): React.JSX.Element {
  const [raw, setRaw] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [hint, setHint] = useState('auto')
  const [dest, setDest] = useState<'inbox' | 'today'>(
    typeof window !== 'undefined' && window.location.hash === '#capture-daily' ? 'today' : 'inbox'
  )
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [note, setNote] = useState<{ msg: string; detail?: string } | null>(null)
  const [recState, setRecState] = useState<'idle' | 'rec' | 'working'>('idle')
  const [attachments, setAttachments] = useState<string[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mediaRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; stream: MediaStream } | null>(null)

  useEffect(() => {
    window.api.projects.list().then(setProjects).catch(() => setProjects([]))
    inputRef.current?.focus()
    const onHash = (): void => {
      setDest(window.location.hash === '#capture-daily' ? 'today' : 'inbox')
      inputRef.current?.focus()
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const noteTimer = useRef<number | undefined>(undefined)
  /** Short status line; `detail` shows on hover. Errors linger longer. */
  const say = (msg: string, detail?: string, ms = 2600): void => {
    setNote({ msg, detail })
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(null), ms)
  }

  const appendText = (t: string): void =>
    setRaw((prev) => (prev ? (prev.endsWith('\n') ? `${prev}${t}` : `${prev}\n${t}`) : t))

  const save = async (): Promise<void> => {
    if (!raw.trim() && attachments.length === 0) return
    setSaving(true)
    try {
      const hasAudio = attachments.some((a) => /\.(wav|mp3|m4a|ogg|flac)$/i.test(a))
      const hasImage = attachments.some((a) => /\.(png|jpe?g|gif|webp|svg)$/i.test(a))
      const kind: NoteKind = hasAudio ? 'voice' : hasImage ? 'image' : 'text'
      if (dest === 'today') {
        const body = attachments.length > 0
          ? `${raw.trim()}\n${attachments.map((a) => `![](${a})`).join('\n')}`.trim()
          : raw.trim()
        await window.api.daily.append(body, kind)
      } else {
        await window.api.inbox.add({
          kind,
          raw: raw.trim(),
          projectHint: hint,
          source: 'popover',
          assets: attachments
        })
      }
      setSaved(true)
      window.setTimeout(() => {
        setSaved(false)
        setRaw('')
        setAttachments([])
        setSaving(false)
        void window.api.popover.hide()
      }, 380)
    } catch (err) {
      setSaving(false)
      say(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void save()
    }
    if (e.key === 'Escape') void window.api.popover.hide()
  }

  // --- voice: MediaRecorder → WAV PCM16 → assets → STT sidecar -------------------
  const toggleRec = (): void => {
    if (recState === 'rec') {
      mediaRef.current?.rec.stop()
      setRecState('working')
    } else {
      void startRec()
    }
  }

  const startRec = async (): Promise<void> => {
    try {
      const stream = await openMic()
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      rec.onstop = () => void finishRec(chunks, stream)
      mediaRef.current = { rec, chunks, stream }
      rec.start()
      setRecState('rec')
    } catch {
      say('Mic blocked', 'Allow Inkfish in System Settings › Privacy & Security › Microphone', 6000)
    }
  }

  const finishRec = async (chunks: Blob[], stream: MediaStream): Promise<void> => {
    stream.getTracks().forEach((t) => t.stop())
    try {
      const wav = await toWav(new Blob(chunks, { type: mediaRef.current?.rec.mimeType }))
      const rel = await window.api.assets.save('voice-note.wav', await blobToDataUrl(wav))
      setAttachments((prev) => [...prev, rel])
      say('Transcribing…')
      try {
        const abs = await window.api.assets.path(rel)
        const stt = await window.api.stt.transcribe(abs)
        appendText(stt.text)
        say(`Transcribed (${stt.provider}) ✓`)
      } catch (e) {
        const why = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        say("Couldn't transcribe — audio saved", why, 6000)
      }
    } catch {
      say('Recording failed — type instead.')
    }
    setRecState('idle')
    mediaRef.current = null
  }

  // --- images: drop / paste / pick → assets/, ref appended inline ----------------
  const ingestFile = async (file: File): Promise<void> => {
    const isImage = file.type.startsWith('image/')
    const isAudio = file.type.startsWith('audio/')
    if (!isImage && !isAudio) {
      say('Only images or audio here.')
      return
    }
    const rel = await window.api.assets.save(file.name, await blobToDataUrl(file))
    setAttachments((prev) => [...prev, rel])
    if (isImage) appendText(`![](${rel})`)
    else appendText(`🎙 \`${rel}\``)
  }

  const ingestMany = (files: Iterable<File>): void => {
    for (const f of files) {
      void ingestFile(f).catch(() => say('File ingest failed.'))
    }
  }

  const pickFile = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*,audio/*'
    input.multiple = true
    input.onchange = () => {
      if (input.files) ingestMany(input.files)
    }
    input.click()
  }

  const importAudio = (): void => {
    window.api.stt
      .pickAudio()
      .then((r) => {
        if ('transcript' in r) appendText(r.transcript.text)
        else if (r.error !== 'cancelled') say(`Import failed: ${r.error}`)
      })
      .catch((e: unknown) => say(String(e)))
  }

  const canSave = raw.trim().length > 0 || attachments.length > 0

  const recLabel = recState === 'rec' ? 'Stop dictation' : recState === 'working' ? 'Transcribing…' : 'Dictate'

  return (
    <div
      className={`capture${saved ? ' pop' : ''}`}
      onKeyDown={onKey}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        if (e.dataTransfer.files.length > 0) ingestMany(e.dataTransfer.files)
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files]
        if (files.length > 0) {
          e.preventDefault()
          ingestMany(files)
        }
      }}
    >
      <div className="cap-top">
        <div className="cap-dest" role="tablist" aria-label="Destination">
          <button role="tab" aria-selected={dest === 'inbox'} className={dest === 'inbox' ? 'on' : ''} onClick={() => setDest('inbox')}>
            Inbox
          </button>
          <button role="tab" aria-selected={dest === 'today'} className={dest === 'today' ? 'on' : ''} onClick={() => setDest('today')}>
            Today
          </button>
        </div>
        {dest === 'inbox' && (
          <select className="cap-project" value={hint} onChange={(e) => setHint(e.target.value)} aria-label="Project">
            <option value="auto">Auto-route</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <textarea
        ref={inputRef}
        className="cap-input"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={dest === 'today' ? 'Add to today…' : 'Capture a thought…'}
      />

      {attachments.length > 0 && (
        <ul className="cap-files">
          {attachments.map((a) => (
            <li key={a}>
              <span>{a.split('/').slice(-1)[0]}</span>
              <button
                aria-label={`Remove ${a}`}
                onClick={() => {
                  setAttachments((prev) => prev.filter((x) => x !== a))
                  setRaw((prev) =>
                    prev
                      .split('\n')
                      .filter((l) => !l.includes(a))
                      .join('\n')
                  )
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="cap-bar">
        <button
          className={`cap-icon${recState === 'rec' ? ' rec' : ''}`}
          title={recLabel}
          aria-label={recLabel}
          disabled={recState === 'working'}
          onClick={toggleRec}
        >
          {recState === 'rec' ? (
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
              <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
              <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
            </svg>
          )}
        </button>
        <button className="cap-icon" title="Attach image or audio" aria-label="Attach image or audio" onClick={pickFile}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.8-5.8a2.3 2.3 0 0 1 3.3 3.3L6.3 11.3a1.1 1.1 0 0 1-1.6-1.6L10 4.5" />
          </svg>
        </button>
        <button className="cap-icon" title="Transcribe an audio file" aria-label="Transcribe an audio file" onClick={importAudio}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <path d="M2 8h1M5 5v6M8 2.5v11M11 5v6M14 8h-1" />
          </svg>
        </button>
        <span className="flex-sp" />
        <button className="cap-save" disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : dest === 'today' ? 'Append' : 'Save'}
          <kbd>⌘↵</kbd>
        </button>
      </div>
      {note && (
        <div className="toast glass" title={note.detail}>
          {note.msg}
          {note.detail && <span className="toast-detail">{note.detail}</span>}
        </div>
      )}
    </div>
  )
}
