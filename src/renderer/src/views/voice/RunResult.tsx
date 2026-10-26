import { useState } from 'react'
import { fmtMsShort, fmtWer } from '../../../../shared/sttBench'
import type { Run } from './helpers'

/**
 * One finished run: headline (time, WER, warm-up, what ran), per-clip chips,
 * error counts + example mix-ups, then the transcript sample, clamped to a few
 * lines and expandable. Stacked rows so nothing gets squeezed at narrow widths.
 */
export function RunResult({
  run,
  fastest
}: {
  run: Extract<Run, { state: 'done' }>
  fastest: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const d = run.detail
  return (
    <>
      <div className="run-head">
        <span className={`engine-ms${fastest ? ' best' : ''}`}>{fmtMs(run.ms)}</span>
        {run.wer !== undefined && <span className="engine-ms">{fmtWer(run.wer)} WER</span>}
        {d && (
          <span className="engine-ms">
            warm-up {fmtMsShort(d.warmMs)}
            {d.loadMs ? ` · load ${fmtMsShort(d.loadMs)}/run` : ''}
          </span>
        )}
        {run.runtime && (
          <span className="muted small engine-runtime" title={run.runtime}>
            {run.runtime}
          </span>
        )}
      </div>
      {d && d.clips.length > 0 && (
        <div className="run-clips">
          {d.clips.map((c) => (
            <span key={c.label} className="tag score">
              {c.label} <b>{fmtWer(c.wer)}</b>
            </span>
          ))}
        </div>
      )}
      {d && (
        <div className="run-errors muted small">
          {d.subs} wrong · {d.dels} missed · {d.ins} extra
          {d.examples.length > 0 && <span className="run-examples"> · e.g. {d.examples.join(', ')}</span>}
        </div>
      )}
      <button
        type="button"
        className={`engine-text${open ? ' open' : ''}`}
        onClick={() => setOpen(!open)}
        title={open ? 'Show less' : 'Show the full transcript'}
        aria-expanded={open}
      >
        {run.text}
      </button>
    </>
  )
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
}
