import { useEffect, useRef, useState } from 'react'
import type { NoteKind, Project } from '../../../shared/types'

/**
 * Capture popover (380px): one combined composer. Type, and/or drop/paste an
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
  const [note, setNote] = useState<string | null>(null)
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

  const say = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(null), 2600)
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
      say('Mic blocked — check permission, or type instead.')
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
      } catch {
        say('STT unavailable — audio kept, describe it in text.')
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

  return (
    <div
      className={`capture glass${saved ? ' pop' : ''}`}
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
      <textarea
        ref={inputRef}
        className="cap-input"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="Type, drop an image, or dictate… (⌘↵ saves to inbox)"
        rows={8}
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

      <div className="cap-tools">
        <button
          className={`btn ghost sm${recState === 'rec' ? ' danger' : ''}`}
          title="Dictate (transcript is appended here)"
          disabled={recState === 'working'}
          onClick={toggleRec}
        >
          {recState === 'rec' ? '● Stop' : recState === 'working' ? '…' : '◉ Dictate'}
        </button>
        <button className="btn ghost sm" title="Attach image or audio" onClick={pickFile}>
          📎 Attach
        </button>
        <button className="btn ghost sm" title="Transcribe an audio file" onClick={importAudio}>
          Import audio…
        </button>
      </div>

      <div className="cap-foot">
        <div className="seg sm" role="group" aria-label="Destination">
          <button className={dest === 'inbox' ? 'on' : ''} onClick={() => setDest('inbox')}>
            Inbox
          </button>
          <button className={dest === 'today' ? 'on' : ''} onClick={() => setDest('today')}>
            Today
          </button>
        </div>
        {dest === 'inbox' && (
          <select value={hint} onChange={(e) => setHint(e.target.value)} aria-label="Project">
            <option value="auto">✨ Auto</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn mint" disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? '…' : dest === 'today' ? 'Append ⌘↵' : 'Save ⌘↵'}
        </button>
      </div>
      {note && <div className="toast glass">{note}</div>}
    </div>
  )
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

/** Decode any recorded audio → 16kHz mono WAV PCM16 for the STT sidecar. */
async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext()
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const targetRate = 16000
    const offline = new OfflineAudioContext(1, Math.ceil((buf.duration * targetRate) / 1), targetRate)
    const src = offline.createBufferSource()
    src.buffer = buf
    src.connect(offline.destination)
    src.start()
    const rendered = await offline.startRendering()
    const data = rendered.getChannelData(0)
    const wav = new ArrayBuffer(44 + data.length * 2)
    const view = new DataView(wav)
    const writeStr = (off: number, s: string): void => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
    }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + data.length * 2, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, targetRate, true)
    view.setUint32(28, targetRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, data.length * 2, true)
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i] ?? 0))
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return new Blob([wav], { type: 'audio/wav' })
  } finally {
    void ctx.close()
  }
}
