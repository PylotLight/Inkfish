import { useEffect, useRef, useState } from 'react'
import type { NoteKind, Project } from '../../../shared/types'

type Kind = 'text' | 'voice' | 'image'

/** Capture popover (380px): autofocus input, Cmd-Enter save, kind tabs, project picker. */
export default function Capture(): React.JSX.Element {
  const [kind, setKind] = useState<Kind>('text')
  const [raw, setRaw] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [hint, setHint] = useState('auto')
  const [saving, setSaving] = useState(false)
  const [squirt, setSquirt] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [recState, setRecState] = useState<'idle' | 'rec' | 'working'>('idle')
  const [imageAsset, setImageAsset] = useState<string | null>(null)
  const [audioAsset, setAudioAsset] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mediaRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; stream: MediaStream } | null>(null)

  useEffect(() => {
    window.api.projects.list().then(setProjects).catch(console.error)
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (kind === 'text') inputRef.current?.focus()
  }, [kind])

  const say = (msg: string): void => {
    setNote(msg)
    window.setTimeout(() => setNote(null), 2600)
  }

  const save = async (): Promise<void> => {
    const text = raw.trim()
    if (!text && !imageAsset && !audioAsset) return
    setSaving(true)
    try {
      const noteKind: NoteKind = kind === 'voice' ? 'voice' : kind === 'image' ? 'image' : 'text'
      const assets = [imageAsset, audioAsset].filter((a): a is string => !!a)
      const body = text || (kind === 'image' ? `![](${imageAsset ?? ''})` : '(voice note)')
      await window.api.inbox.add({
        kind: noteKind,
        raw: body,
        projectHint: hint,
        source: 'popover',
        assets
      })
      // Ink-squirt save animation, then clear + hide (popover semantics).
      setSquirt(true)
      window.setTimeout(() => {
        setSquirt(false)
        setRaw('')
        setImageAsset(null)
        setAudioAsset(null)
        setSaving(false)
        void window.api.popover.hide()
      }, 380)
    } catch (err) {
      setSaving(false)
      say(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void save()
    }
    if (e.key === 'Escape') void window.api.popover.hide()
  }

  // --- voice: MediaRecorder → WAV PCM16 → assets → STT sidecar -------------------
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

  const stopRec = (): void => {
    mediaRef.current?.rec.stop()
    setRecState('working')
  }

  const finishRec = async (chunks: Blob[], stream: MediaStream): Promise<void> => {
    stream.getTracks().forEach((t) => t.stop())
    try {
      const wav = await toWav(new Blob(chunks, { type: mediaRef.current?.rec.mimeType }))
      const rel = await window.api.assets.save('voice-note.wav', await blobToDataUrl(wav))
      setAudioAsset(rel)
      const abs = await window.api.assets.path(rel)
      say('Transcribing…')
      try {
        const stt = await window.api.stt.transcribe(abs)
        setRaw((prev) => (prev ? `${prev}\n${stt.text}` : stt.text))
        say(stt.provider === 'parakeet' ? 'Transcribed ✓' : `Transcribed (${stt.provider}) ✓`)
      } catch {
        say('STT unavailable — describe the note in text.')
      }
    } catch {
      say('Recording failed — type instead.')
    }
    setRecState('idle')
    mediaRef.current = null
  }

  // --- image: drop / paste / pick → assets/ ---------------------------------------
  const ingestImage = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) {
      say('Only images here.')
      return
    }
    const rel = await window.api.assets.save(file.name, await blobToDataUrl(file))
    setImageAsset(rel)
    setRaw((prev) => (prev ? `${prev}\n![](${rel})` : `![](${rel})`))
  }

  const pickImage = async (): Promise<void> => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const f = input.files?.[0]
      if (f) void ingestImage(f).catch(() => say('Image ingest failed.'))
    }
    input.click()
  }

  const canSave = raw.trim().length > 0 || imageAsset !== null || audioAsset !== null

  return (
    <div className={`capture glass${squirt ? ' squirt' : ''}`} onKeyDown={onKey}>
      <div className="cap-tabs" role="tablist" aria-label="Capture kind">
        {(['text', 'voice', 'image'] as Kind[]).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            className={kind === k ? 'active' : ''}
            onClick={() => setKind(k)}
          >
            {k === 'text' ? 'Text' : k === 'voice' ? 'Voice' : 'Image'}
          </button>
        ))}
      </div>

      {kind === 'text' && (
        <textarea
          ref={inputRef}
          className="cap-input"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Squirt ink… (⌘↵ saves to inbox)"
          rows={7}
        />
      )}

      {kind === 'voice' && (
        <div className="cap-voice">
          <div className="row">
            {recState === 'rec' ? (
              <button className="btn danger" onClick={stopRec}>
                ● Stop
              </button>
            ) : (
              <button className="btn" disabled={recState === 'working'} onClick={() => void startRec()}>
                {recState === 'working' ? 'Working…' : '◉ Record'}
              </button>
            )}
            <button
              className="btn ghost"
              onClick={() =>
                window.api.stt
                  .pickAudio()
                  .then((r) => {
                    if ('transcript' in r) setRaw((p) => (p ? `${p}\n${r.transcript.text}` : r.transcript.text))
                    else if (r.error !== 'cancelled') say(`Import failed: ${r.error}`)
                  })
                  .catch((e: unknown) => say(String(e)))
              }
            >
              Import audio…
            </button>
          </div>
          <textarea
            className="cap-input"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Transcript lands here — edit, then ⌘↵"
            rows={5}
          />
          {audioAsset && <p className="muted small">🎙 {audioAsset}</p>}
        </div>
      )}

      {kind === 'image' && (
        <div
          className="cap-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const f = e.dataTransfer.files?.[0]
            if (f) void ingestImage(f).catch(() => say('Image ingest failed.'))
          }}
          onPaste={(e) => {
            const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'))
            if (f) void ingestImage(f).catch(() => say('Image ingest failed.'))
          }}
        >
          {imageAsset ? (
            <p className="muted">🖼 {imageAsset}</p>
          ) : (
            <p className="muted">Drop / paste an image here, or…</p>
          )}
          <button className="btn ghost" onClick={() => void pickImage()}>
            Choose image…
          </button>
          <textarea
            className="cap-input"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="Caption (optional)…"
            rows={3}
          />
        </div>
      )}

      <div className="cap-foot">
        <select value={hint} onChange={(e) => setHint(e.target.value)} aria-label="Project">
          <option value="auto">✨ Auto</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn mint" disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? '…' : 'Squirt ⌘↵'}
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
