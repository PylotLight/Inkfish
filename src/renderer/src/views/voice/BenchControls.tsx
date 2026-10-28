import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { SttEngine, SttResult } from '../../../../shared/types'
import {
  BENCH_CLIP,
  BENCH_MODES,
  corpusWer,
  fmtMsShort,
  modeSeconds,
  speedFactor,
  wordErrorRate,
  type BenchClip,
  type BenchMode
} from '../../../../shared/sttBench'
import { blobToDataUrl, ipcError, openMic, toWav } from '../../audio'
import { isWebEngine, resetWeb, transcribeWeb } from '../../webStt'
import {
  CLIP_SECONDS,
  CLIP_URLS,
  type Clip,
  type Run,
  type RunDetail,
  type Score,
  scoresKey,
  wavSeconds,
  withTimeout
} from './helpers'

export function BenchControls({
  engines,
  hidden,
  note,
  setNote,
  setScores,
  setDeepScores,
  setRuns,
  scored,
  deepScored,
  bulk,
  downloadAll
}: {
  engines: SttEngine[] | null
  hidden: Set<string>
  note: string | null
  setNote: (n: string | null) => void
  scores: Record<string, Score>
  setScores: Dispatch<SetStateAction<Record<string, Score>>>
  deepScores: Record<string, Score>
  setDeepScores: Dispatch<SetStateAction<Record<string, Score>>>
  runs: Record<string, Run>
  setRuns: Dispatch<SetStateAction<Record<string, Run>>>
  scored: Array<[string, Score]>
  deepScored: Array<[string, Score]>
  bulk: boolean
  downloadAll: () => Promise<void>
}): React.JSX.Element {
  const [mode, setMode] = useState<BenchMode>('quick')
  const [clip, setClip] = useState<Clip | null>(null)
  const [reference, setReference] = useState('')
  const [comparing, setComparing] = useState(false)
  const [benchStep, setBenchStep] = useState<{ done: number; total: number; name: string } | null>(null)
  const [recording, setRecording] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadClip = async (blob: Blob, label: string, ref?: string): Promise<Clip> => {
    const wav = await toWav(blob)
    const c: Clip = { dataUrl: await blobToDataUrl(wav), wav, label, seconds: wavSeconds(wav), reference: ref }
    setClip(c)
    setReference(ref ?? '')
    setRuns({})
    return c
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
      void loadClip(new Blob(chunks, { type: rec.mimeType }), `${CLIP_SECONDS} s recording`)
    }
    rec.start()
    setRecording(true)
    window.setTimeout(() => rec.state === 'recording' && rec.stop(), CLIP_SECONDS * 1000)
  }

  const compare = async (given?: Clip): Promise<void> => {
    const c = given ?? clip
    if (!c || !engines) return
    const ref = (given ? c.reference : reference)?.trim() || ''
    setComparing(true)
    const targets = engines.filter((e) => e.ready && !hidden.has(e.id))
    setRuns(Object.fromEntries(targets.map((e) => [e.id, { state: 'running' } as Run])))
    // Sequential: engines share the Neural Engine, parallel runs skew timings.
    for (const [i, e] of targets.entries()) {
      setBenchStep({ done: i, total: targets.length, name: e.name })
      // One wedged engine must not stall the whole run: cap each at 1 min + 2× the clip.
      const limit = Math.round(60_000 + c.seconds * 2_000)
      const once = (): Promise<SttResult> =>
        isWebEngine(e.id)
          ? withTimeout(transcribeWeb(e.id, c.wav), limit, e.name, () => resetWeb(e.id))
          : window.api.stt.test(c.dataUrl, e.id, limit)
      try {
        const r = await once()
        const ms = r.ms ?? 0
        const wer = ref ? wordErrorRate(ref, r.text).wer : undefined
        const speed = speedFactor(c.seconds, ms) || undefined
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
    setBenchStep(null)
    setComparing(false)
  }

  /** Load a bundled benchmark clip as 16 kHz wav (for native) + data URL. */
  const loadBenchClip = async (b: BenchClip): Promise<Clip> => {
    const wav = await toWav(await (await fetch(CLIP_URLS[b.id]!)).blob())
    return { dataUrl: await blobToDataUrl(wav), wav, label: b.label, seconds: wavSeconds(wav), reference: b.text }
  }

  /**
   * Quick: one clip. Deep: every Deep clip, scored per clip and corpus-wide.
   * Per engine: one cold warm-up run (timed — that's the warm-up figure), then
   * each clip timed; speed excludes model load so native (fresh helper per run)
   * and Web (kept warm) compare fairly, and load time is shown on its own.
   */
  const benchmark = async (m: BenchMode): Promise<void> => {
    if (!engines) return
    setNote(null)
    setComparing(true)
    setClip(null)
    let clips: { b: BenchClip; c: Clip }[]
    try {
      clips = await Promise.all(BENCH_MODES[m].clips.map(async (b) => ({ b, c: await loadBenchClip(b) })))
    } catch (err) {
      setNote(`Benchmark clips: ${ipcError(err)}`)
      setComparing(false)
      return
    }
    const targets = engines.filter((e) => e.ready && !hidden.has(e.id))
    setRuns(Object.fromEntries(targets.map((e) => [e.id, { state: 'running' } as Run])))
    for (const [i, e] of targets.entries()) {
      const step = (what: string): void => setBenchStep({ done: i, total: targets.length, name: `${e.name} · ${what}` })
      const run = (c: Clip, limit: number): Promise<SttResult> =>
        isWebEngine(e.id)
          ? withTimeout(transcribeWeb(e.id, c.wav), limit, e.name, () => resetWeb(e.id))
          : window.api.stt.test(c.dataUrl, e.id, limit)
      try {
        // First load can compile for the Neural Engine / WebGPU: allow 10 min.
        step('warming up')
        const w0 = performance.now()
        await run(clips[0]!.c, 600_000)
        const warmMs = Math.round(performance.now() - w0)
        const per: { b: BenchClip; r: SttResult; w: ReturnType<typeof wordErrorRate> }[] = []
        for (const [k, { b, c }] of clips.entries()) {
          step(clips.length > 1 ? `${b.label} (${k + 1} of ${clips.length})` : 'timing')
          const r = await run(c, Math.round(60_000 + c.seconds * 2_000))
          per.push({ b, r, w: wordErrorRate(b.text, r.text) })
        }
        const audio = per.reduce((a, p) => a + p.b.seconds, 0)
        const decodeMs = per.reduce((a, p) => a + Math.max(1, (p.r.ms ?? 0) - (p.r.loadMs ?? 0)), 0)
        const loads = per.map((p) => p.r.loadMs ?? 0).filter((x) => x > 0)
        const score: Score = {
          wer: corpusWer(per.map((p) => p.w)),
          speed: speedFactor(audio, decodeMs),
          at: Date.now(),
          warmMs,
          loadMs: loads.length ? Math.round(loads.reduce((a, b) => a + b, 0) / loads.length) : undefined,
          subs: per.reduce((a, p) => a + p.w.subs, 0),
          dels: per.reduce((a, p) => a + p.w.dels, 0),
          ins: per.reduce((a, p) => a + p.w.ins, 0),
          clips: Object.fromEntries(per.map((p) => [p.b.id, { wer: p.w.wer, errors: p.w.errors, words: p.w.words }]))
        }
        const set = m === 'quick' ? setScores : setDeepScores
        set((prev) => {
          const next = { ...prev, [e.id]: score }
          localStorage.setItem(scoresKey(m), JSON.stringify(next))
          return next
        })
        const detail: RunDetail = {
          clips: per.length > 1 ? per.map((p) => ({ label: p.b.label, wer: p.w.wer })) : [],
          subs: score.subs ?? 0,
          dels: score.dels ?? 0,
          ins: score.ins ?? 0,
          warmMs,
          loadMs: score.loadMs,
          examples: [...new Set(per.flatMap((p) => p.w.confusions))].slice(0, 5)
        }
        setRuns((p) => ({
          ...p,
          [e.id]: {
            state: 'done',
            text: per[0]!.r.text.trim() || '(no speech heard)',
            ms: decodeMs,
            runtime: per[0]!.r.runtime,
            wer: score.wer,
            speed: score.speed,
            detail
          }
        }))
      } catch (err) {
        setRuns((p) => ({ ...p, [e.id]: { state: 'error', text: ipcError(err) } }))
      }
    }
    setBenchStep(null)
    setComparing(false)
  }

  const ready = engines?.filter((e) => e.ready) ?? []
  const benchable = ready.filter((e) => !hidden.has(e.id))

  return (
    <div className="setting-row stacked" style={{ marginTop: 16 }}>
      <span className="setting-label">
        Compare engines
        <span className="muted small setting-hint">
          {clip
            ? `Clip: ${clip.label}`
            : mode === 'quick'
              ? `Quick: every downloaded, visible engine on one ${Math.round(BENCH_CLIP.seconds)} s clip of clean read English. Same yardstick each time.`
              : `Deep: ${BENCH_MODES.deep.clips.length} clips, ~${Math.round(modeSeconds('deep') / 60)} min per engine — three Australian earnings calls (numbers, names, jargon, ums) and harder read speech from 13 speakers. Scored per clip, with wrong / missed / extra words and warm-up time.`}
        </span>
      </span>
      <div className="row" style={{ marginTop: 0 }}>
        <div className="seg sm" role="radiogroup" aria-label="Benchmark mode">
          {(['quick', 'deep'] as BenchMode[]).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? 'on' : ''}
              disabled={comparing}
              onClick={() => setMode(m)}
            >
              {BENCH_MODES[m].label} · {fmtMsShort(modeSeconds(m) * 1000)}
            </button>
          ))}
        </div>
        <button
          className="btn sm mint"
          disabled={recording || comparing || benchable.length === 0}
          onClick={() => void benchmark(mode)}
        >
          {comparing ? 'Running…' : `Benchmark ${benchable.length} engine${benchable.length === 1 ? '' : 's'}`}
        </button>
        {(engines?.filter((x) => x.downloadable && !x.ready && !hidden.has(x.id)).length ?? 0) > 0 && (
          <button className="btn ghost sm" disabled={bulk || comparing} onClick={() => void downloadAll()}>
            {bulk
              ? 'Downloading…'
              : `Download all ${engines!.filter((x) => x.downloadable && !x.ready && !hidden.has(x.id)).length}`}
          </button>
        )}
        <button className="btn ghost sm" disabled={recording || comparing} onClick={() => void record()}>
          {recording ? `Recording… (${CLIP_SECONDS} s)` : 'Record clip'}
        </button>
        <button className="btn ghost sm" disabled={recording || comparing} onClick={() => fileRef.current?.click()}>
          Use audio file…
        </button>
        {clip && (
          <button
            className="btn ghost sm"
            disabled={comparing || benchable.length === 0}
            onClick={() => void compare()}
          >
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
            if (f) void loadClip(f, f.name).catch((err) => setNote(`Couldn't read ${f.name}: ${ipcError(err)}`))
            e.target.value = ''
          }}
        />
      </div>
      {benchStep && (
        <div className="dl" style={{ marginTop: 10 }}>
          <div className="dl-track" aria-hidden>
            <div className="dl-bar" style={{ width: `${Math.max(2, (benchStep.done / benchStep.total) * 100)}%` }} />
          </div>
          <span className="muted small">
            {benchStep.done + 1} of {benchStep.total} · {benchStep.name}
          </span>
        </div>
      )}
      {clip && (
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
      {(scored.length > 0 || deepScored.length > 0) && (
        <p className="muted small setting-hint">
          Scores are from the last Quick and Deep runs on this Mac. Numbers are spelled out and ums ignored before
          scoring, so “$30 million” and “thirty million dollars” match.
        </p>
      )}
      {note && (
        <p className="small setting-hint error-text" style={{ overflowWrap: 'anywhere' }}>
          {note}
        </p>
      )}
    </div>
  )
}
