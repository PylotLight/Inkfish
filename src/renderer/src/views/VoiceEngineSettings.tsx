import { useEffect, useRef, useState } from 'react'
import { pickAutoEngine } from '../../../shared/stt'
import type { SttEngine } from '../../../shared/types'
import { blobToDataUrl, ipcError, loadAudioPrefs, openMic, saveAudioPrefs, toWav } from '../audio'
import benchUrl from '../assets/bench/librispeech-1272.wav?url'
import { BENCH_CLIP, fmtSpeed, fmtWer, speedFactor, wordErrorRate } from '../../../shared/sttBench'
import { isWebEngine, prepareWeb, removeWeb, transcribeWeb, webEngines } from '../webStt'

type Run =
  | { state: 'running' }
  | { state: 'done'; text: string; ms: number; runtime?: string; wer?: number; speed?: number }
  | { state: 'error'; text: string }

const CLIP_SECONDS = 6
const SCORES_KEY = 'inkfish.sttScores'

/** Last benchmark-clip result per engine, kept so the list stays comparable. */
type Score = { wer: number; speed: number; at: number }
function loadScores(): Record<string, Score> {
  try {
    return JSON.parse(localStorage.getItem(SCORES_KEY) || '{}') as Record<string, Score>
  } catch {
    return {}
  }
}

/** Duration of a 16 kHz mono 16-bit wav from toWav(). */
const wavSeconds = (wav: Blob): number => Math.max(0, wav.size - 44) / 32000

type Clip = { dataUrl: string; wav: Blob; label: string; seconds: number; reference?: string }

/**
 * Settings › Voice Engine — FluidVoice-style: the active model up top, every
 * other model below with Activate / Download / Delete, and a compare bench
 * that runs one clip through every ready engine.
 */
export default function VoiceEngineSettings(): React.JSX.Element {
  const [engines, setEngines] = useState<SttEngine[] | null>(null)
  const [choice, setChoice] = useState(loadAudioPrefs().engine)
  const [busy, setBusy] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const [clip, setClip] = useState<Clip | null>(null)
  const [reference, setReference] = useState('')
  const [scores, setScores] = useState<Record<string, Score>>(loadScores)
  const [captions, setCaptions] = useState(loadAudioPrefs().liveCaptions)
  const [recording, setRecording] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = async (): Promise<void> => {
    let native: SttEngine[] = []
    try {
      native = await window.api.stt.engines()
    } catch (e) {
      setNote(ipcError(e))
    }
    setEngines([...native, ...webEngines()])
  }

  useEffect(() => {
    void refresh()
  }, [])

  const activate = (id: string): void => {
    setChoice(id)
    saveAudioPrefs({ engine: id })
  }

  const withBusy = async (e: SttEngine, label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy((b) => ({ ...b, [e.id]: label }))
    setNote(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setNote(`${e.name}: ${ipcError(err)}`)
    }
    setBusy((b) => {
      const { [e.id]: _, ...rest } = b
      return rest
    })
  }

  const download = (e: SttEngine): Promise<void> =>
    withBusy(e, 'Downloading…', async () => {
      if (isWebEngine(e.id)) await prepareWeb(e.id)
      else await window.api.stt.prepare(e.id)
      if (!choice) activate(e.id)
    })

  const remove = (e: SttEngine): Promise<void> =>
    withBusy(e, 'Removing…', async () => {
      if (isWebEngine(e.id)) await removeWeb(e.id)
      else await window.api.stt.remove(e.id)
      if (choice === e.id) activate('')
    })

  const useClip = async (blob: Blob, label: string, ref?: string): Promise<Clip> => {
    const wav = await toWav(blob)
    const c: Clip = { dataUrl: await blobToDataUrl(wav), wav, label, seconds: wavSeconds(wav), reference: ref }
    setClip(c)
    setReference(ref ?? '')
    setRuns({})
    return c
  }

  const benchClip = async (): Promise<Clip> => {
    const blob = await (await fetch(benchUrl)).blob()
    return useClip(blob, `Benchmark · ${Math.round(BENCH_CLIP.seconds)} s of read English (LibriSpeech)`, BENCH_CLIP.text)
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

  const compare = async (given?: Clip): Promise<void> => {
    const c = given ?? clip
    if (!c || !engines) return
    const ref = (given ? c.reference : reference)?.trim() || ''
    const isBench = ref === BENCH_CLIP.text
    setComparing(true)
    const targets = engines.filter((e) => e.ready)
    setRuns(Object.fromEntries(targets.map((e) => [e.id, { state: 'running' } as Run])))
    // Sequential: engines share the Neural Engine, parallel runs skew timings.
    for (const e of targets) {
      try {
        const r = isWebEngine(e.id)
          ? await transcribeWeb(e.id, c.wav)
          : await window.api.stt.test(c.dataUrl, e.id)
        const ms = r.ms ?? 0
        const wer = ref ? wordErrorRate(ref, r.text).wer : undefined
        const speed = speedFactor(c.seconds, ms) || undefined
        if (isBench && wer !== undefined && speed) {
          setScores((prev) => {
            const next = { ...prev, [e.id]: { wer, speed, at: Date.now() } }
            localStorage.setItem(SCORES_KEY, JSON.stringify(next))
            return next
          })
        }
        setRuns((p) => ({
          ...p,
          [e.id]: {
            state: 'done',
            text: r.text.trim() || '(no speech heard)',
            ms,
            runtime: r.runtime,
            wer,
            speed
          }
        }))
      } catch (err) {
        setRuns((p) => ({
          ...p,
          [e.id]: { state: 'error', text: ipcError(err) }
        }))
      }
    }
    setComparing(false)
  }

  const ready = engines?.filter((e) => e.ready) ?? []
  const chosen = engines?.find((e) => e.id === choice && e.ready)
  const active = chosen ?? (engines ? pickAutoEngine(engines) : undefined)
  const others = engines?.filter((e) => e.id !== active?.id) ?? []
  const scored = Object.entries(scores).filter(([id]) => engines?.some((e) => e.id === id))
  const bestWer = Math.min(...scored.map(([, v]) => v.wer))
  const bestSpeed = Math.max(...scored.map(([, v]) => v.speed))
  const benchAll = async (): Promise<void> => {
    setNote(null)
    try {
      await compare(await benchClip())
    } catch (err) {
      setNote(`Benchmark clip: ${ipcError(err)}`)
    }
  }
  const fastest = Math.min(...Object.values(runs).flatMap((r) => (r.state === 'done' && r.ms > 0 ? [r.ms] : [])))

  const row = (e: SttEngine, isActive: boolean): React.JSX.Element => {
    const run = runs[e.id]
    return (
      <div key={e.id} className={`engine-row${isActive ? ' active' : ''}${e.available ? '' : ' off'}`} role="listitem">
        <EngineIcon family={e.family} />
        <div className="engine-main">
          <div className="engine-name">{e.name}</div>
          {e.subtitle && <div className="muted small">{e.subtitle}</div>}
          <div className="engine-tags">
            {e.size && <span className="tag">{e.size}</span>}
            {e.languages && <span className="tag">{e.languages}</span>}
            {!e.ready && <span className="tag dim">{e.detail}</span>}
            {scores[e.id] && (
              <>
                <span
                  className={`tag score${scores[e.id]!.wer === bestWer ? ' best' : ''}`}
                  title="Word error rate on the benchmark clip — lower is more accurate"
                >
                  {fmtWer(scores[e.id]!.wer)} errors
                </span>
                <span
                  className={`tag score${scores[e.id]!.speed === bestSpeed ? ' best' : ''}`}
                  title="Seconds of audio per second of processing on this Mac — higher is faster"
                >
                  {fmtSpeed(scores[e.id]!.speed)}
                </span>
              </>
            )}
            {e.ready && e.id.startsWith('apple-speech') && <span className="tag dim">Needs Siri or Dictation</span>}
          </div>
          {run && (
            <div className={`engine-run ${run.state}`}>
              {run.state === 'running' && <span className="muted small">Transcribing…</span>}
              {run.state === 'done' && (
                <>
                  <span className={`engine-ms${run.ms === fastest ? ' best' : ''}`}>{fmtMs(run.ms)}</span>
                  {run.wer !== undefined && <span className="engine-ms">{fmtWer(run.wer)} WER</span>}
                  <span className="engine-text">{run.text}</span>
                  {run.runtime && <span className="muted small engine-runtime">{run.runtime}</span>}
                </>
              )}
              {run.state === 'error' && <span className="small error-text">{run.text}</span>}
            </div>
          )}
        </div>
        <div className="engine-actions">
          {busy[e.id] ? (
            <span className="muted small">{busy[e.id]}</span>
          ) : isActive ? (
            <>
              <span className="pill active">{chosen ? 'Active' : 'Active · Auto'}</span>
              {e.ready && e.downloadable === false && e.family !== 'apple' && (
                <button
                  className="icon-btn"
                  title="Delete model"
                  aria-label={`Delete ${e.name}`}
                  onClick={() => void remove(e)}
                >
                  ✕
                </button>
              )}
            </>
          ) : e.ready ? (
            <>
              <button className="btn sm mint" onClick={() => activate(e.id)}>
                Activate
              </button>
              {e.family !== 'apple' && (
                <button
                  className="icon-btn"
                  title="Delete model"
                  aria-label={`Delete ${e.name}`}
                  onClick={() => void remove(e)}
                >
                  ✕
                </button>
              )}
            </>
          ) : e.downloadable ? (
            <button className="btn ghost sm" onClick={() => void download(e)}>
              Download
            </button>
          ) : (
            <span className="muted small">Unavailable</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <section className="settings-group">
      <h4>Voice Engine</h4>
      <p className="muted small setting-hint" style={{ marginTop: -4 }}>
        Everything runs on this Mac. Native models use the Neural Engine; “· Web” models run in-app on WebGPU or WASM.
        Models download once.
      </p>

      {engines === null && <p className="muted small">Checking engines…</p>}

      {engines && (
        <>
          <h5 className="engine-heading">Active model</h5>
          <div className="engine-list" role="list">
            {active ? (
              row(active, true)
            ) : (
              <p className="muted small engine-empty">No engine ready yet — download one below.</p>
            )}
          </div>
          {choice && !chosen && (
            <p className="muted small setting-hint">Your chosen engine isn't ready, so Auto is filling in.</p>
          )}

          <h5 className="engine-heading">Other models</h5>
          <div className="engine-list" role="list">
            {others.map((e) => row(e, false))}
          </div>
        </>
      )}

      <div className="setting-row inline" style={{ marginTop: 16 }}>
        <div className="setting-label">
          Live transcription while dictating
          <span className="muted small setting-hint">
            Text streams in as you speak. Uses Parakeet Redux once downloaded (and skips the wait after stop when
            Redux is your engine); otherwise Moonshine previews in English.
          </span>
        </div>
        <button
          role="switch"
          aria-checked={captions}
          className={`switch${captions ? ' on' : ''}`}
          onClick={() => {
            setCaptions(!captions)
            saveAudioPrefs({ liveCaptions: !captions })
          }}
          aria-label="Live captions"
        >
          <span className="knob" />
        </button>
      </div>

      <div className="setting-row stacked" style={{ marginTop: 16 }}>
        <span className="setting-label">
          Compare engines
          <span className="muted small setting-hint">
            {clip
              ? `Clip: ${clip.label}`
              : `Benchmark runs every downloaded engine on a ${Math.round(BENCH_CLIP.seconds)} s clip with a known transcript and scores accuracy (word error rate, lower is better) and speed on this Mac. Or try your own recording or file.`}
          </span>
        </span>
        <div className="row" style={{ marginTop: 0 }}>
          <button
            className="btn sm mint"
            disabled={recording || comparing || ready.length === 0}
            onClick={() => void benchAll()}
          >
            {comparing ? 'Running…' : `Benchmark ${ready.length} engine${ready.length === 1 ? '' : 's'}`}
          </button>
          <button className="btn ghost sm" disabled={recording || comparing} onClick={() => void record()}>
            {recording ? `Recording… (${CLIP_SECONDS} s)` : 'Record clip'}
          </button>
          <button className="btn ghost sm" disabled={recording || comparing} onClick={() => fileRef.current?.click()}>
            Use audio file…
          </button>
          {clip && clip.reference !== BENCH_CLIP.text && (
            <button className="btn ghost sm" disabled={comparing || ready.length === 0} onClick={() => void compare()}>
              {comparing ? 'Comparing…' : 'Compare on this clip'}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void useClip(f, f.name).catch((err) => setNote(`Couldn't read ${f.name}: ${ipcError(err)}`))
              e.target.value = ''
            }}
          />
        </div>
        {clip && clip.reference !== BENCH_CLIP.text && (
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="grow"
              type="text"
              value={reference}
              placeholder="What was said (optional) — adds an error rate for this clip"
              onChange={(e) => setReference(e.target.value)}
              aria-label="Reference transcript"
            />
          </div>
        )}
        {scored.length > 0 && (
          <p className="muted small setting-hint">
            Scores on each model are from the last benchmark on this Mac. Accuracy is on clean read English; noisy calls
            and accents will score worse for every model.
          </p>
        )}
        {note && (
          <p className="small setting-hint error-text" style={{ overflowWrap: 'anywhere' }}>
            {note}
          </p>
        )}
      </div>
    </section>
  )
}

function EngineIcon({ family }: { family?: string }): React.JSX.Element {
  const label = family === 'nvidia' ? 'NV' : family === 'cohere' ? 'Co' : ''
  return (
    <span className={`engine-icon ${family ?? 'apple'}`} aria-hidden>
      {label || (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.6-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.5-1-2.5-3.9zM14 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z" />
        </svg>
      )}
    </span>
  )
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}
