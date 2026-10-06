import { useState } from 'react'

interface Props {
  onClose: () => void
  onImported: () => void
  notify: (msg: string) => void
  /** Render as a full center page instead of a modal popup. */
  page?: boolean
}

/** Meeting import: paste transcript or import Teams .vtt / audio → kind: meeting. */
export default function MeetingImport({ onClose, onImported, notify, page }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const pickFile = async (): Promise<void> => {
    const r = await window.api.meeting.pickFile()
    if ('text' in r) {
      setText(r.text)
      notify(r.format === 'vtt' ? 'Teams .vtt loaded ✓' : 'Transcript loaded ✓')
    } else if (r.error !== 'cancelled') {
      notify(`Import failed: ${r.error}`)
    }
  }

  const pickAudio = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.stt.pickAudio()
      if ('transcript' in r) {
        setText(r.transcript.text)
        notify(`Transcribed via ${r.transcript.provider} ✓`)
      } else if (r.error !== 'cancelled') {
        notify(`STT failed: ${r.error}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const looksVtt = /^WEBVTT/m.test(text) || /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(text)
      await window.api.meeting.import({
        text,
        format: looksVtt ? 'vtt' : 'text',
        title: title.trim() || undefined,
        source: 'meeting'
      })
      notify('Meeting dropped in inbox ✓')
      onImported()
      onClose()
    } catch (err) {
      notify(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return page ? (
    <div className="settings-page meeting-page" aria-label="Meeting notes">
      <div className="row settings-top">
        <div>
          <span className="eyebrow">Capture</span>
          <h2 className="settings-title">Meeting notes</h2>
          <p className="muted small settings-sub">Paste a transcript, import a Teams .vtt export, or transcribe audio.</p>
        </div>
        <span className="flex-sp" />
        <button className="btn ghost sm" onClick={onClose}>
          ← Back
        </button>
      </div>
      <Body
        text={text}
        setText={setText}
        title={title}
        setTitle={setTitle}
        busy={busy}
        pickFile={() => void pickFile()}
        pickAudio={() => void pickAudio()}
        save={() => void save()}
        onClose={onClose}
      />
    </div>
  ) : (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass strong meeting" onClick={(e) => e.stopPropagation()}>
        <h3>Meeting notes</h3>
        <p className="muted">Paste a transcript, import a Teams .vtt export, or transcribe audio.</p>
        <Body
          text={text}
          setText={setText}
          title={title}
          setTitle={setTitle}
          busy={busy}
          pickFile={() => void pickFile()}
          pickAudio={() => void pickAudio()}
          save={() => void save()}
          onClose={onClose}
        />
      </div>
    </div>
  )
}

function Body({
  text, setText, title, setTitle, busy, pickFile, pickAudio, save, onClose
}: {
  text: string
  setText: (v: string) => void
  title: string
  setTitle: (v: string) => void
  busy: boolean
  pickFile: () => void
  pickAudio: () => void
  save: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <>
        <div className="row wrap">
          <button className="btn ghost sm" disabled={busy} onClick={pickFile}>
            Import .vtt / .txt…
          </button>
          <button className="btn ghost sm" disabled={busy} onClick={pickAudio}>
            Transcribe audio…
          </button>
        </div>
        <label className="field">
          <span>Title (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sprint planning…" />
        </label>
        <label className="field">
          <span>Transcript</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="WEBVTT… or plain transcript…"
            rows={12}
          />
        </label>
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn mint" disabled={!text.trim() || busy} onClick={save}>
            Drop in inbox
          </button>
        </div>
    </>
  )
}
