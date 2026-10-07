import { useEffect, useRef, useState } from 'react'
import type { SttEngine } from '../../../shared/types'
import { blobToDataUrl, ipcError, loadAudioPrefs, openMic, saveAudioPrefs, toWav } from '../audio'

type Run = { state: 'running' } | { state: 'done'; text: string; ms: number } | { state: 'error'; text: string }

const CLIP_SECONDS = 6
const PREPARABLE = /^(parakeet-(v3|redux|ultra|v2)|apple-analyzer)$/

/** Settings › Transcription: every engine on this Mac, download, pick default, compare side by side. */
export default function TranscriptionSettings(): React.JSX.Element {
  const [engines, setEngines] = useState<SttEngine[] | null>(null)
  const [choice, setChoice] = useState(loadAudioPrefs().engine)
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const [clip, setClip] = useState<{ dataUrl: string; label: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = async (): Promise<void> => {
    try {
      setEngines(await window.api.stt.engines())
    } catch (e) {
      setNote(ipcError(e))
      setEngines([])
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const pick = (id: string): void => {
    setChoice(id)
    saveAudioPrefs({ engine: id })
  }

  const download = async (e: SttEngine): Promise<void> => {
    setBusy((b) => ({ ...b, [e.id]: 'Downloading…' }))
    setNote(null)
    try {
      await window.api.stt.prepare(e.id)
      await refresh()
    } catch (err) {
      setNote(`${e.name}: ${ipcError(err)}`)
    }
    setBusy((b) => {
      const { [e.id]: _, ...rest } = b
      return rest
    })
  }

  const useClip = async (blob: Blob, label: string): Promise<void> => {
    const wav = await toWav(blob)
    setClip({ dataUrl: await blobToDataUrl(wav), label })
    setRuns({})
  }

  const record = async (): Promise<void> => {
    setNote(null)
    let stream: MediaStream
    try {
      stream = await openMic()
    } catch {
      setNote('Mic blocked — allow Inkfish in System Settings › Privacy & Security › Microphone.')
      return
    }
    const rec = new MediaRecorder(stream)
    const chunks: Blob[] = []
    rec.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data)
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      setRecording(false)
      void useClip(new Blob(chunks, { type: rec.mimeType }), `${CLIP_SECONDS} s recording`)
    }
    rec.start()
    setRecording(true)
    window.setTimeout(() => rec.state === 'recording' && rec.stop(), CLIP_SECONDS * 1000)
  }

  const importFile = (f: File | undefined): void => {
    if (f) void useClip(f, f.name).catch((e) => setNote(`Couldn't read ${f.name}: ${ipcError(e)}`))
  }

  const compare = async (): Promise<void> => {
    if (!clip || !engines) return
    setComparing(true)
    const targets = engines.filter((e) => e.ready)
    setRuns(Object.fromEntries(targets.map((e) => [e.id, { state: 'running' } as Run])))
    // Sequential: engines share the Neural Engine / GPU, parallel runs skew timings.
    for (const e of targets) {
      try {
        const r = await window.api.stt.test(clip.dataUrl, e.id)
        setRuns((p) => ({ ...p, [e.id]: { state: 'done', text: r.text.trim() || '(no speech heard)', ms: r.ms ?? 0 } }))
      } catch (err) {
        setRuns((p) => ({ ...p, [e.id]: { state: 'error', text: ipcError(err) } }))
      }
    }
    setComparing(false)
  }

  const ready = engines?.filter((e) => e.ready) ?? []
  const fastest = Math.min(
    ...Object.values(runs).flatMap((r) => (r.state === 'done' && r.ms > 0 ? [r.ms] : []))
  )

  return (
    <section className="settings-group">
      <h4>Transcription</h4>

      <div className="setting-row stacked">
        <span className="setting-label">
          Engine for voice notes
          <span className="muted small setting-hint">Everything runs on this Mac. Auto uses the best engine that's ready.</span>
        </span>
        <select value={choice} onChange={(e) => pick(e.target.value)} aria-label="Transcription engine">
          <option value="">Auto{ready[0] ? ` (${autoName(ready)})` : ''}</option>
          {ready.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      <div className="engine-list" role="list">
        {engines === null && <p className="muted small">Checking engines…</p>}
        {engines?.map((e) => {
          const run = runs[e.id]
          return (
            <div key={e.id} className={`engine-row${e.available ? '' : ' off'}`} role="listitem">
              <div className="engine-head">
                <div className="engine-name">
                  <span className={`dot ${e.ready ? 'ok' : e.available ? 'warn' : 'off'}`} aria-hidden />
                  {e.name}
                </div>
                {busy[e.id] ? (
                  <span className="muted small">{busy[e.id]}</span>
                ) : e.available && !e.ready && PREPARABLE.test(e.id) ? (
                  <button className="btn ghost sm" onClick={() => void download(e)}>
                    Download
                  </button>
                ) : e.ready ? (
                  <span className="muted small">Ready</span>
                ) : null}
              </div>
              <p className="muted small engine-detail">{e.detail}</p>
              {run && (
                <div className={`engine-run ${run.state}`}>
                  {run.state === 'running' && <span className="muted small">Transcribing…</span>}
                  {run.state === 'done' && (
                    <>
                      <span className={`engine-ms${run.ms === fastest ? ' best' : ''}`}>{fmtMs(run.ms)}</span>
                      <span className="engine-text">{run.text}</span>
                    </>
                  )}
                  {run.state === 'error' && <span className="small error-text">{run.text}</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="setting-row stacked" style={{ marginTop: 14 }}>
        <span className="setting-label">
          Compare engines
          <span className="muted small setting-hint">
            {clip ? `Clip: ${clip.label}` : `Record ${CLIP_SECONDS} seconds or pick an audio file, then run every ready engine on it.`}
          </span>
        </span>
        <div className="row" style={{ marginTop: 0 }}>
          <button className="btn ghost sm" disabled={recording || comparing} onClick={() => void record()}>
            {recording ? `Recording… (${CLIP_SECONDS} s)` : 'Record clip'}
          </button>
          <button className="btn ghost sm" disabled={recording || comparing} onClick={() => fileRef.current?.click()}>
            Use audio file…
          </button>
          <button className="btn sm mint" disabled={!clip || comparing || ready.length === 0} onClick={() => void compare()}>
            {comparing ? 'Comparing…' : `Compare ${ready.length} engine${ready.length === 1 ? '' : 's'}`}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => {
              importFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
        {note && <p className="small setting-hint error-text" style={{ overflowWrap: 'anywhere' }}>{note}</p>}
      </div>
    </section>
  )
}

const AUTO_ORDER = ['parakeet-ultra', 'parakeet-v3', 'parakeet-redux', 'parakeet-v2', 'apple-analyzer', 'apple-speech', 'parakeet-cli']

function autoName(ready: SttEngine[]): string {
  if (ready[0]?.id === 'override') return ready[0].name
  for (const id of AUTO_ORDER) {
    const e = ready.find((x) => x.id === id)
    if (e) return e.name
  }
  return ready[0]?.name ?? ''
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}
