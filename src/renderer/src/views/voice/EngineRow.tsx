import type { DownloadProgress, SttEngine } from '../../../../shared/types'
import { fmtSpeed, fmtWer } from '../../../../shared/sttBench'
import { phaseLabel, sizeLabel, type Run, type Score } from './helpers'
import { RunResult } from './RunResult'

function HideButton({
  e,
  hidden,
  onToggle
}: {
  e: SttEngine
  hidden: boolean
  onToggle: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      className="icon-btn"
      title={hidden ? 'Show in lists and benchmarks' : 'Hide from lists and benchmarks'}
      aria-label={`${hidden ? 'Show' : 'Hide'} ${e.name}`}
      aria-pressed={hidden}
      onClick={() => onToggle(e.id)}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
        {!hidden && <path d="M3 3l18 18" />}
      </svg>
    </button>
  )
}

function EngineIcon({ family }: { family?: string }): React.JSX.Element {
  return (
    <span className={`engine-icon ${family ?? 'apple'}`} aria-hidden>
      {family === 'nvidia' ? (
        'NV'
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.6-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.5-1-2.5-3.9zM14 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.6 2.8-1.4z" />
        </svg>
      )}
    </span>
  )
}

export function EngineRow({
  engine,
  active,
  chosen,
  hidden,
  run,
  fastest,
  dl,
  busy,
  score,
  deepScore,
  bestWer,
  bestSpeed,
  bestDeep,
  onActivate,
  onDownload,
  onPause,
  onDiscard,
  onRemove,
  onHide
}: {
  engine: SttEngine
  active: boolean
  chosen: boolean
  hidden: boolean
  run?: Run
  fastest: number
  dl?: DownloadProgress
  busy?: string
  score?: Score
  deepScore?: Score
  bestWer?: number
  bestSpeed?: number
  bestDeep?: number
  onActivate: (id: string) => void
  onDownload: (e: SttEngine) => void
  onPause: (e: SttEngine) => void
  onDiscard: (e: SttEngine) => void
  onRemove: (e: SttEngine) => void
  onHide: (id: string) => void
}): React.JSX.Element {
  return (
    <div
      className={`engine-row${active ? ' active' : ''}${engine.available ? '' : ' off'}${hidden ? ' is-hidden' : ''}`}
      role="listitem"
    >
      <EngineIcon family={engine.family} />
      <div className="engine-main">
        <div className="engine-name">{engine.name}</div>
        {engine.subtitle && <div className="muted small">{engine.subtitle}</div>}
        <div className="engine-tags">
          {(engine.bytes || engine.size) && (
            <span className="tag" title={engine.bytes ? 'On disk' : 'Approximate download'}>
              {sizeLabel(engine)}
            </span>
          )}
          {engine.languages && <span className="tag">{engine.languages}</span>}
          {!engine.ready && !dl && !busy && <span className="tag dim">{engine.detail}</span>}
          {score && (
            <>
              <span
                className={`tag score${score.wer === bestWer ? ' best' : ''}`}
                title="Word error rate on the benchmark clip — lower is more accurate"
              >
                {fmtWer(score.wer)} errors
              </span>
              <span
                className={`tag score${score.speed === bestSpeed ? ' best' : ''}`}
                title="Seconds of audio per second of processing on this Mac — higher is faster"
              >
                {fmtSpeed(score.speed)}
              </span>
            </>
          )}
          {deepScore && (
            <span
              className={`tag score${deepScore.wer === bestDeep ? ' best' : ''}`}
              title="Word error rate on the Deep benchmark (Australian calls + hard read speech)"
            >
              Deep {fmtWer(deepScore.wer)}
            </span>
          )}
        </div>
        {(dl || busy === 'Downloading…') && (
          <div className={`dl ${dl?.state ?? 'downloading'}`}>
            <div className="dl-track" aria-hidden>
              <div
                className={`dl-bar${dl && !(dl.bytes !== undefined && !dl.totalBytes) ? '' : ' indeterminate'}`}
                style={dl ? { width: `${Math.max(2, dl.fraction * 100)}%` } : undefined}
              />
            </div>
            <span className="muted small">{dl ? phaseLabel(dl, engine) : 'Downloading…'}</span>
            {dl?.error && (dl.state === 'error' || dl.state === 'retrying') && (
              <span className="small error-text dl-error">
                {dl.blocked
                  ? 'Hugging Face looks blocked — a VPN, firewall or network filter is the usual cause. Retry, or switch Download source below.'
                  : dl.error}
              </span>
            )}
          </div>
        )}
        {run && (
          <div className={`engine-run ${run.state}`}>
            {run.state === 'running' && <span className="muted small">Transcribing…</span>}
            {run.state === 'done' && <RunResult run={run} fastest={run.ms === fastest} />}
            {run.state === 'error' && <span className="small error-text">{run.text}</span>}
          </div>
        )}
      </div>
      <div className="engine-actions">
        {dl && (dl.state === 'downloading' || dl.state === 'retrying') ? (
          <button className="btn ghost sm" onClick={() => onPause(engine)}>
            Pause
          </button>
        ) : dl && (dl.state === 'paused' || dl.state === 'error') ? (
          <>
            <button className="btn ghost sm" onClick={() => void onDownload(engine)}>
              {dl.state === 'paused' ? 'Resume' : 'Retry'}
            </button>
            <button
              className="icon-btn"
              title="Cancel download"
              aria-label={`Cancel ${engine.name} download`}
              onClick={() => void onDiscard(engine)}
            >
              ✕
            </button>
          </>
        ) : busy ? (
          <span className="muted small">{busy}</span>
        ) : active ? (
          <>
            <span className="pill active">{chosen ? 'Active' : 'Active · Auto'}</span>
            {engine.ready && engine.downloadable === false && engine.family !== 'apple' && (
              <button
                className="icon-btn"
                title="Delete model"
                aria-label={`Delete ${engine.name}`}
                onClick={() => void onRemove(engine)}
              >
                ✕
              </button>
            )}
          </>
        ) : engine.ready ? (
          <>
            <button className="btn sm mint" onClick={() => onActivate(engine.id)}>
              Activate
            </button>
            <HideButton e={engine} hidden={hidden} onToggle={onHide} />
            {engine.family !== 'apple' && (
              <button
                className="icon-btn"
                title="Delete model"
                aria-label={`Delete ${engine.name}`}
                onClick={() => void onRemove(engine)}
              >
                ✕
              </button>
            )}
          </>
        ) : engine.downloadable ? (
          <>
            <button className="btn ghost sm" onClick={() => void onDownload(engine)}>
              Download
            </button>
            <HideButton e={engine} hidden={hidden} onToggle={onHide} />
          </>
        ) : (
          <>
            <span className="muted small">Unavailable</span>
            <HideButton e={engine} hidden={hidden} onToggle={onHide} />
          </>
        )}
      </div>
    </div>
  )
}
