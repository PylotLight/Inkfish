import { useEffect, useRef, useState } from 'react'
import { pickAutoEngine } from '../../../shared/stt'
import type { DownloadProgress, SttEngine } from '../../../shared/types'
import { ipcError, loadAudioPrefs, saveAudioPrefs } from '../audio'
import { BENCH_MODES, corpusWer, fmtMsShort, fmtWer } from '../../../shared/sttBench'
import { isWebEngine, prepareWeb, removeWeb, webEngines } from '../webStt'
import { HIDDEN_KEY, type Run, type Score, MIRRORS, loadHidden, loadScores, sizeLabel } from './voice/helpers'
import { BenchControls } from './voice/BenchControls'
import { EngineRow } from './voice/EngineRow'

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
  const [scores, setScores] = useState<Record<string, Score>>(() => loadScores('quick'))
  const [deepScores, setDeepScores] = useState<Record<string, Score>>(() => loadScores('deep'))
  const [hidden, setHidden] = useState<Set<string>>(loadHidden)
  const [showHidden, setShowHidden] = useState(false)
  const [captions, setCaptions] = useState(loadAudioPrefs().liveCaptions)
  const [note, setNote] = useState<string | null>(null)
  const [dl, setDl] = useState<Record<string, DownloadProgress>>({})
  const [mirror, setMirror] = useState(loadAudioPrefs().modelMirror)
  const [bulk, setBulk] = useState(false)

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
    void window.api.stt.downloads().then((list) => setDl(Object.fromEntries(list.map((p) => [p.id, p]))))
    return window.api.stt.onProgress((p) => {
      setDl((prev) => {
        if (p.state === 'done') {
          const { [p.id]: _, ...rest } = prev
          return rest
        }
        return { ...prev, [p.id]: p }
      })
    })
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

  /** Native downloads report progress over IPC; web ones show a busy bar. */
  const download = async (e: SttEngine): Promise<boolean> => {
    setNote(null)
    if (isWebEngine(e.id)) {
      let ok = true
      const show = (p: Partial<DownloadProgress>): void =>
        setDl((prev) => ({
          ...prev,
          [e.id]: {
            id: e.id,
            state: 'downloading',
            fraction: 0,
            phase: 'downloading',
            files: 0,
            total: 0,
            attempt: 0,
            ...p
          }
        }))
      await withBusy(e, 'Downloading…', async () => {
        try {
          show({ phase: 'listing' })
          await prepareWeb(e.id, (p) =>
            show(
              p.phase === 'loading'
                ? { fraction: 1, phase: 'compiling', bytes: undefined, totalBytes: undefined }
                : {
                    fraction: p.total ? Math.min(1, p.loaded / p.total) : 0,
                    bytes: p.loaded,
                    totalBytes: p.total,
                    file: p.file
                  }
            )
          )
        } catch (err) {
          ok = false
          throw err
        } finally {
          setDl(({ [e.id]: _, ...rest }) => rest)
        }
      })
      if (ok && !choice) activate(e.id)
      return ok
    }
    try {
      await window.api.stt.prepare(e.id, mirror)
      const list = await window.api.stt.engines()
      setEngines([...list, ...webEngines()])
      const done = list.find((x) => x.id === e.id)?.ready ?? false
      if (done && !choice) activate(e.id)
      return done
    } catch (err) {
      setNote(`${e.name}: ${ipcError(err)}`)
      return false
    }
  }

  const stopBulk = useRef(false)
  const pause = (e: SttEngine): void => {
    stopBulk.current = true
    void window.api.stt.pause(e.id)
  }
  const discard = async (e: SttEngine): Promise<void> => {
    await window.api.stt.clearDownload(e.id)
    setDl(({ [e.id]: _, ...rest }) => rest)
  }

  const downloadAll = async (): Promise<void> => {
    if (!engines) return
    setBulk(true)
    stopBulk.current = false
    // One at a time: parallel model downloads just split the bandwidth.
    for (const e of engines.filter((x) => x.downloadable && !x.ready && !hidden.has(x.id))) {
      await download(e)
      if (stopBulk.current) break
    }
    setBulk(false)
  }

  const remove = (e: SttEngine): Promise<void> =>
    withBusy(e, 'Removing…', async () => {
      if (isWebEngine(e.id)) await removeWeb(e.id)
      else await window.api.stt.remove(e.id)
      if (choice === e.id) activate('')
    })

  const toggleHidden = (id: string): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const chosen = engines?.find((e) => e.id === choice && e.ready)
  const active = chosen ?? (engines ? pickAutoEngine(engines) : undefined)
  const others = engines?.filter((e) => e.id !== active?.id) ?? []
  const visibleOthers = others.filter((e) => showHidden || !hidden.has(e.id))
  const hiddenCount = others.filter((e) => hidden.has(e.id)).length
  const scored = Object.entries(scores).filter(([id]) => engines?.some((e) => e.id === id))
  const bestWer = Math.min(...scored.map(([, v]) => v.wer))
  const bestSpeed = Math.max(
    ...Object.entries({ ...scores, ...deepScores })
      .filter(([id]) => engines?.some((e) => e.id === id))
      .map(([, v]) => v.speed)
  )
  const deepScored = Object.entries(deepScores).filter(([id]) => engines?.some((e) => e.id === id))
  const bestDeep = Math.min(...deepScored.map(([, v]) => v.wer))
  const ausWer = (sc?: Score): number | undefined => {
    const a = Object.entries(sc?.clips ?? {}).filter(([k]) => k.startsWith('aus-'))
    return a.length ? corpusWer(a.map(([, v]) => v)) : undefined
  }
  const bestAus = Math.min(...deepScored.flatMap(([, v]) => (ausWer(v) === undefined ? [] : [ausWer(v)!])))
  const fastest = Math.min(...Object.values(runs).flatMap((r) => (r.state === 'done' && r.ms > 0 ? [r.ms] : [])))

  return (
    <section className="settings-group">
      <h4>Voice Engine</h4>
      <p className="muted small setting-hint" style={{ marginTop: -4 }}>
        Everything runs on this Mac. Parakeet Redux runs natively with Core ML, or in-app on WebGPU + WASM (“· Web”).
        Apple Speech · macOS 26+ is built into macOS. Models download once.
      </p>

      {engines === null && <p className="muted small">Checking engines…</p>}

      {engines && (
        <>
          <h5 className="engine-heading">Active model</h5>
          <div className="engine-list" role="list">
            {active ? (
              <EngineRow
                engine={active}
                active
                chosen={!!chosen}
                hidden={hidden.has(active.id)}
                run={runs[active.id]}
                fastest={fastest}
                dl={dl[active.id]}
                busy={busy[active.id]}
                score={scores[active.id]}
                deepScore={deepScores[active.id]}
                bestWer={bestWer}
                bestSpeed={bestSpeed}
                bestDeep={bestDeep}
                onActivate={activate}
                onDownload={download}
                onPause={pause}
                onDiscard={discard}
                onRemove={remove}
                onHide={toggleHidden}
              />
            ) : (
              <p className="muted small engine-empty">No engine ready yet — download one below.</p>
            )}
          </div>
          {choice && !chosen && (
            <p className="muted small setting-hint">Your chosen engine isn't ready, so Auto is filling in.</p>
          )}

          <h5 className="engine-heading">
            Other models
            {hiddenCount > 0 && (
              <button className="link-btn small" onClick={() => setShowHidden(!showHidden)}>
                {showHidden ? 'Hide hidden' : `Show ${hiddenCount} hidden`}
              </button>
            )}
          </h5>
          <div className="engine-list" role="list">
            {visibleOthers.map((e) => (
              <EngineRow
                key={e.id}
                engine={e}
                active={false}
                chosen={false}
                hidden={hidden.has(e.id)}
                run={runs[e.id]}
                fastest={fastest}
                dl={dl[e.id]}
                busy={busy[e.id]}
                score={scores[e.id]}
                deepScore={deepScores[e.id]}
                bestWer={bestWer}
                bestSpeed={bestSpeed}
                bestDeep={bestDeep}
                onActivate={activate}
                onDownload={download}
                onPause={pause}
                onDiscard={discard}
                onRemove={remove}
                onHide={toggleHidden}
              />
            ))}
          </div>
        </>
      )}

      <div className="setting-row inline" style={{ marginTop: 16 }}>
        <div className="setting-label">
          Download source
          <span className="muted small setting-hint">
            Where native Parakeet Redux downloads from. If a VPN or network blocks Hugging Face, try the mirror. Paused
            downloads resume where they stopped.
          </span>
        </div>
        <select
          value={MIRRORS.some((m) => m.url === mirror) ? mirror : '__custom__'}
          onChange={(ev) => {
            const v = ev.target.value === '__custom__' ? mirror || 'https://' : ev.target.value
            setMirror(v)
            saveAudioPrefs({ modelMirror: v })
          }}
          aria-label="Download source"
        >
          {MIRRORS.map((m) => (
            <option key={m.url} value={m.url}>
              {m.label}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
      </div>
      {!MIRRORS.some((m) => m.url === mirror) && (
        <div className="row" style={{ marginTop: 6 }}>
          <input
            className="grow"
            type="url"
            value={mirror}
            placeholder="https://your-mirror.example"
            onChange={(ev) => {
              setMirror(ev.target.value)
              saveAudioPrefs({ modelMirror: ev.target.value })
            }}
            aria-label="Custom download source"
            spellCheck={false}
          />
        </div>
      )}

      <div className="setting-row inline" style={{ marginTop: 16 }}>
        <div className="setting-label">
          Live transcription while dictating
          <span className="muted small setting-hint">
            Text streams in as you speak. Needs Parakeet Redux · Web downloaded (and skips the wait after stop when
            Redux is your engine).
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

      {engines && (
        <div className="setting-row stacked" style={{ marginTop: 16 }}>
          <span className="setting-label">
            Model comparison
            <span className="muted small setting-hint">
              Errors are word error rate (lower is better): Quick is clean read English; Deep adds Australian earnings
              calls and harder read speech. Speed is decoding only (higher is faster); warm-up is the cold first run;
              load is model load per run for native engines. Hidden models are left out.
            </span>
          </span>
          <div className="bench-scroll">
            <table className="bench-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Size</th>
                  <th>Quick</th>
                  <th>Deep</th>
                  <th>Aussie</th>
                  {BENCH_MODES.deep.clips.map((c) => (
                    <th key={c.id} title={`${c.kind} · ${Math.round(c.seconds)} s`}>
                      {c.label}
                    </th>
                  ))}
                  <th>Speed</th>
                  <th>Warm-up</th>
                  <th>Load</th>
                  <th>Languages</th>
                </tr>
              </thead>
              <tbody>
                {engines
                  .filter((e) => !hidden.has(e.id))
                  .sort(
                    (a, b) =>
                      (deepScores[a.id]?.wer ?? 9) - (deepScores[b.id]?.wer ?? 9) ||
                      (scores[a.id]?.wer ?? 9) - (scores[b.id]?.wer ?? 9) ||
                      a.name.localeCompare(b.name)
                  )
                  .map((e) => {
                    const sc = scores[e.id]
                    const dp = deepScores[e.id]
                    const au = ausWer(dp)
                    const sp = dp?.speed ?? sc?.speed
                    const warm = dp?.warmMs ?? sc?.warmMs
                    const load = dp?.loadMs ?? sc?.loadMs
                    const none = e.ready ? 'Not run' : '—'
                    return (
                      <tr key={e.id} className={e.ready ? '' : 'dim'}>
                        <td>{e.name}</td>
                        <td>{sizeLabel(e)}</td>
                        <td className={sc && sc.wer === bestWer ? 'best' : ''}>{sc ? fmtWer(sc.wer) : none}</td>
                        <td className={dp && dp.wer === bestDeep ? 'best' : ''}>{dp ? fmtWer(dp.wer) : none}</td>
                        <td className={au !== undefined && au === bestAus ? 'best' : ''}>
                          {au !== undefined ? fmtWer(au) : '—'}
                        </td>
                        {BENCH_MODES.deep.clips.map((c) => (
                          <td key={c.id}>{dp?.clips?.[c.id] ? fmtWer(dp.clips[c.id]!.wer) : '—'}</td>
                        ))}
                        <td className={sp !== undefined && sp === bestSpeed ? 'best' : ''}>
                          {sp ? `${sp >= 10 ? Math.round(sp) : sp.toFixed(1)}×` : '—'}
                        </td>
                        <td>{warm ? fmtMsShort(warm) : '—'}</td>
                        <td>{load ? fmtMsShort(load) : '—'}</td>
                        <td>{e.languages || '—'}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <BenchControls
        engines={engines}
        hidden={hidden}
        note={note}
        setNote={setNote}
        scores={scores}
        setScores={setScores}
        deepScores={deepScores}
        setDeepScores={setDeepScores}
        runs={runs}
        setRuns={setRuns}
        scored={scored}
        deepScored={deepScored}
        bulk={bulk}
        downloadAll={downloadAll}
      />
    </section>
  )
}
