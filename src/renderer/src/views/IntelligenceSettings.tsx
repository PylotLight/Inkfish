import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_INTEL_PREFS,
  INTEL_SAMPLE,
  type IntelPrefs,
  type IntelResult,
  type IntelEngineId,
  type IntelStatus,
  type IntelStyle,
  type IntelTask
} from '../../../shared/intelligence'
import { INTEL_RUNTIMES, intelRuntime, isSupportedLfm3TextModelId } from '../../../shared/intel-runtime'
import { ipcError } from '../audio'

const STYLES: Array<{ id: IntelStyle; name: string; hint: string }> = [
  { id: 'light', name: 'Light', hint: 'Punctuation, casing and filler words only. Every sentence stays.' },
  {
    id: 'standard',
    name: 'Standard',
    hint: 'Also drops false starts and applies spoken corrections ("no wait, Thursday").'
  },
  { id: 'structured', name: 'Structured', hint: 'Standard, then bullets, to-dos and headings where the note has them.' }
]

const TASKS: Array<{ id: IntelTask; label: string }> = [
  { id: 'cleanup', label: 'Clean up' },
  { id: 'organize', label: 'Organise' },
  { id: 'summarize', label: 'Summarise' }
]

type Run = { state: 'running'; task: IntelTask } | { state: 'done'; r: IntelResult } | { state: 'error'; text: string }

/** What to tell the user for each unavailable reason, and whether a System Settings button helps. */
function fixFor(s: IntelStatus, engine: IntelEngineId): { hint: string; openSettings: boolean } | null {
  if (engine !== 'apple') {
    if (s.available) return null
    return {
      hint:
        s.reason === 'invalidUrl'
          ? 'Use a localhost, 127.0.0.1 or ::1 URL. Embedded inference will not connect to a remote host.'
          : s.reason === 'incompatible'
            ? 'The server answered, but its /models route did not return the expected OpenAI-compatible model list.'
            : s.reason === 'invalidModel' || s.reason === 'modelUnavailable' || s.reason === 'modelNotFound'
              ? 'Select the exact /models ID for the LFM3-1.7B text checkpoint. Other model families and the vision checkpoint are not enabled in this text-only path.'
              : 'Start the selected local engine and expose its OpenAI-compatible /v1/chat/completions API, then check again.',
      openSettings: false
    }
  }
  switch (s.reason) {
    case 'available':
      return null
    case 'appleIntelligenceNotEnabled':
      return { hint: 'Turn on Apple Intelligence, then check again.', openSettings: true }
    case 'modelNotReady':
      return {
        hint: 'macOS downloads the model in the background. Keep the Mac online and on power.',
        openSettings: true
      }
    case 'deviceNotEligible':
      return {
        hint: 'Apple Intelligence needs an Apple silicon Mac. Inkfish keeps using its rules engine.',
        openSettings: false
      }
    case 'osTooOld':
      return { hint: 'Update to macOS 26 (Tahoe) to use the on-device model.', openSettings: false }
    case 'sdkMissing':
      return { hint: 'Rebuild the helper with Xcode 26 (`bun run stt:build --force`).', openSettings: false }
    default:
      return { hint: 'Inkfish keeps using its rules engine until this clears.', openSettings: false }
  }
}

/**
 * Settings › Intelligence — embedded runtime status, capture behaviour and a
 * playground for testing cleanup, organisation and summaries.
 */
export default function IntelligenceSettings(): React.JSX.Element {
  const [status, setStatus] = useState<IntelStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [prefs, setPrefs] = useState<IntelPrefs>(DEFAULT_INTEL_PREFS)
  const [input, setInput] = useState(INTEL_SAMPLE)
  const [run, setRun] = useState<Run | null>(null)
  const saveTimer = useRef<number | null>(null)
  const pendingPrefs = useRef<Partial<IntelPrefs> | null>(null)

  const check = async (fresh = true): Promise<void> => {
    setChecking(true)
    try {
      if (saveTimer.current && pendingPrefs.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
        const pending = pendingPrefs.current
        pendingPrefs.current = null
        await window.api.intel.setPrefs(pending)
      }
      setStatus(await window.api.intel.status(fresh))
    } catch (e) {
      setStatus({ available: false, reason: 'helper', detail: ipcError(e) })
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void window.api.intel
      .prefs()
      .then(setPrefs)
      .catch(() => undefined)
    void check(false)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [])

  const update = (patch: Partial<IntelPrefs>, debounce = false): void => {
    setPrefs((p) => ({ ...p, ...patch }))
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    const combined = { ...(pendingPrefs.current ?? {}), ...patch }
    if (debounce) {
      pendingPrefs.current = combined
      saveTimer.current = window.setTimeout(() => {
        pendingPrefs.current = null
        saveTimer.current = null
        void window.api.intel.setPrefs(combined).catch(() => undefined)
      }, 400)
    } else {
      pendingPrefs.current = null
      saveTimer.current = null
      void window.api.intel.setPrefs(combined).catch(() => undefined)
    }
  }

  const test = async (task: IntelTask): Promise<void> => {
    if (!input.trim()) return
    setRun({ state: 'running', task })
    try {
      setRun({ state: 'done', r: await window.api.intel.run({ task, text: input, prefs }) })
    } catch (e) {
      setRun({ state: 'error', text: ipcError(e) })
    }
  }

  const on = prefs.provider !== 'off'
  const selectedRuntime = prefs.engine === 'apple' ? null : intelRuntime(prefs.engine)
  const fix = status ? fixFor(status, prefs.engine) : null
  const ready = status?.available ?? false

  const selectEngine = (engine: IntelEngineId): void => {
    const patch: Partial<IntelPrefs> = {
      engine,
      provider: prefs.provider === 'off' ? 'off' : engine === 'apple' ? 'apple' : 'local'
    }
    if (engine !== 'apple') {
      if (!isSupportedLfm3TextModelId(prefs.localModel)) patch.localModel = intelRuntime(engine).modelExample
      const previousDefault =
        prefs.engine === 'apple' ? DEFAULT_INTEL_PREFS.localBaseUrl : intelRuntime(prefs.engine).defaultBaseUrl
      if (!prefs.localBaseUrl || prefs.localBaseUrl === previousDefault)
        patch.localBaseUrl = intelRuntime(engine).defaultBaseUrl
    }
    const combined = { ...(pendingPrefs.current ?? {}), ...patch }
    pendingPrefs.current = null
    setPrefs((p) => ({ ...p, ...combined }))
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    void window.api.intel
      .setPrefs(combined)
      .then(() => check(true))
      .catch(() => undefined)
  }

  return (
    <>
      <section className="settings-group">
        <h4>Embedded model</h4>
        <p className="muted small setting-hint" style={{ marginTop: 0 }}>
          Choose a verified local endpoint for the LFM3-1.7B text model. Endpoints are loopback-only; Inkfish does not
          bundle runtime binaries or model weights. LFM3-VL-2B is not enabled here because this path does not send image
          payloads.
        </p>

        <label className="field">
          <span>Inference engine</span>
          <select
            value={prefs.engine}
            onChange={(e) => selectEngine(e.target.value as IntelEngineId)}
            aria-label="Inference engine"
          >
            <option value="apple">Apple Foundation Models</option>
            {INTEL_RUNTIMES.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.name}
              </option>
            ))}
          </select>
        </label>

        {selectedRuntime && (
          <>
            <label className="field">
              <span>Local API URL</span>
              <input
                type="url"
                value={prefs.localBaseUrl}
                onChange={(e) => update({ localBaseUrl: e.target.value }, true)}
                aria-label="Local model API URL"
                placeholder={selectedRuntime.defaultBaseUrl}
              />
            </label>
            <label className="field">
              <span>
                LFM3-1.7B model ID <span className="muted small">(required; must match /models)</span>
              </span>
              <input
                value={prefs.localModel}
                onChange={(e) => update({ localModel: e.target.value }, true)}
                aria-label="Local model ID"
                placeholder={selectedRuntime.modelExample}
              />
            </label>
            <p className="muted small setting-hint">
              {selectedRuntime.hint} Format: {selectedRuntime.formats}. {selectedRuntime.platform}.
            </p>
          </>
        )}

        <div className={`engine-row${ready ? ' active' : ''}`}>
          <span className="engine-icon" aria-hidden>
            AI
          </span>
          <div className="engine-main">
            <div className="engine-name">
              {prefs.engine === 'apple' ? 'Apple Foundation Models' : selectedRuntime?.name}
            </div>
            <span className="muted small">
              {status ? status.detail : 'Checking…'}
              {prefs.engine === 'apple' && status?.runtime && <span className="engine-runtime">{status.runtime}</span>}
            </span>
            {fix && <p className="muted small setting-hint">{fix.hint}</p>}
            <div className="engine-tags">
              {prefs.engine === 'apple' ? (
                <>
                  <span className="tag">On-device · ~3B</span>
                  <span className="tag dim">Built in · macOS 26+</span>
                </>
              ) : (
                <>
                  <span className="tag">Local · OpenAI-compatible</span>
                  <span className="tag dim">{selectedRuntime?.formats}</span>
                </>
              )}
              {prefs.engine === 'apple' && status?.languages && status.languages.length > 0 && (
                <span className="tag dim" title={status.languages.join(', ')}>
                  {status.languages.length} languages
                </span>
              )}
            </div>
          </div>
          <div className="engine-actions">
            {ready && <span className="pill active">Ready</span>}
            {fix?.openSettings && (
              <button className="btn ghost sm" onClick={() => void window.api.intel.openSystemSettings()}>
                Open System Settings
              </button>
            )}
            <button className="btn ghost sm" disabled={checking} onClick={() => void check(true)}>
              {checking ? 'Checking…' : prefs.engine === 'apple' ? 'Check again' : 'Check connection'}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h4>On capture</h4>

        <div className="setting-row inline">
          <div className="setting-label">
            Use embedded intelligence
            <span className="muted small setting-hint">
              Off, or while it&apos;s unavailable, Inkfish files notes with its keyword rules. The raw capture is always
              kept.
            </span>
          </div>
          <button
            role="switch"
            aria-checked={on}
            className={`switch${on ? ' on' : ''}`}
            onClick={() => update({ provider: on ? 'off' : prefs.engine === 'apple' ? 'apple' : 'local' })}
            aria-label="Use embedded intelligence"
          >
            <span className="knob" />
          </button>
        </div>

        <div className="setting-row inline">
          <div className="setting-label">
            Clean up notes
            <span className="muted small setting-hint">Removes filler and false starts, fixes punctuation.</span>
          </div>
          <button
            role="switch"
            aria-checked={prefs.cleanup}
            disabled={!on}
            className={`switch${prefs.cleanup ? ' on' : ''}`}
            onClick={() => update({ cleanup: !prefs.cleanup })}
            aria-label="Clean up notes"
          >
            <span className="knob" />
          </button>
        </div>

        <div className="setting-row inline">
          <div className="setting-label">
            Organise into projects
            <span className="muted small setting-hint">
              Picks the title, project and tags. Choosing a project in Capture always wins.
            </span>
          </div>
          <button
            role="switch"
            aria-checked={prefs.organize}
            disabled={!on}
            className={`switch${prefs.organize ? ' on' : ''}`}
            onClick={() => update({ organize: !prefs.organize })}
            aria-label="Organise into projects"
          >
            <span className="knob" />
          </button>
        </div>

        <div className="setting-row inline">
          <div className="setting-label">
            Add action items
            <span className="muted small setting-hint">Appends to-dos it hears as a checklist.</span>
          </div>
          <button
            role="switch"
            aria-checked={prefs.actionItems}
            disabled={!on || !prefs.organize}
            className={`switch${prefs.actionItems ? ' on' : ''}`}
            onClick={() => update({ actionItems: !prefs.actionItems })}
            aria-label="Add action items"
          >
            <span className="knob" />
          </button>
        </div>

        <div className="setting-row stacked">
          <span className="setting-label">Cleanup style</span>
          <div className="seg-row" role="radiogroup" aria-label="Cleanup style">
            {STYLES.map((s) => (
              <button
                key={s.id}
                role="radio"
                aria-checked={prefs.style === s.id}
                className={`seg${prefs.style === s.id ? ' selected' : ''}`}
                onClick={() => update({ style: s.id })}
                title={s.hint}
              >
                {s.name}
              </button>
            ))}
          </div>
          <p className="muted small setting-hint">{STYLES.find((s) => s.id === prefs.style)?.hint}</p>
        </div>

        <div className="setting-row stacked">
          <span className="setting-label">Creativity</span>
          <div className="font-slider-row">
            <button
              className="btn ghost sm"
              title="Reset to default"
              onClick={() => update({ temperature: DEFAULT_INTEL_PREFS.temperature })}
              aria-label="Reset creativity"
            >
              ↺
            </button>
            <span className="font-size-num" aria-live="polite">
              {prefs.temperature.toFixed(1)}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={prefs.temperature}
              onChange={(e) => update({ temperature: Number(e.target.value) }, true)}
              aria-label="Creativity (temperature)"
            />
          </div>
          <p className="muted small setting-hint">Keep it low for cleanup. Higher values reword more freely.</p>
        </div>

        <div className="setting-row stacked">
          <span className="setting-label">Your words</span>
          <textarea
            className="intel-text"
            rows={3}
            value={prefs.instructions}
            maxLength={1200}
            placeholder="Names, product terms and habits, e.g. Inkfish and Parakeet are product names. Use Australian spelling."
            onChange={(e) => update({ instructions: e.target.value }, true)}
            aria-label="Custom instructions"
          />
          <p className="muted small setting-hint">Sent with every request so names and spelling come out right.</p>
        </div>
      </section>

      <section className="settings-group">
        <h4>Try it</h4>
        <div className="setting-row stacked">
          <span className="setting-label">
            Test text
            <span className="muted small setting-hint">Uses the settings on this page, saved or not.</span>
          </span>
          <textarea
            className="intel-text"
            rows={5}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Text to test"
          />
          <div className="row" style={{ marginTop: 8 }}>
            {TASKS.map((t) => (
              <button
                key={t.id}
                className="btn ghost sm"
                disabled={!ready || run?.state === 'running' || !input.trim()}
                onClick={() => void test(t.id)}
              >
                {run?.state === 'running' && run.task === t.id ? 'Thinking…' : t.label}
              </button>
            ))}
            <button className="btn ghost sm" onClick={() => setInput(INTEL_SAMPLE)} title="Restore the sample">
              ↺ Sample
            </button>
          </div>
          {!ready && status && <p className="muted small setting-hint">Available once the selected engine is ready.</p>}

          {run?.state === 'error' && (
            <p className="small setting-hint error-text" style={{ overflowWrap: 'anywhere' }}>
              {run.text}
            </p>
          )}
          {run?.state === 'done' && <IntelOutput r={run.r} />}
        </div>
      </section>
    </>
  )
}

function IntelOutput({ r }: { r: IntelResult }): React.JSX.Element {
  return (
    <div className="intel-out">
      <div className="row between intel-out-head">
        <span className="muted small">
          {r.task === 'cleanup' ? 'Cleaned up' : r.task === 'organize' ? 'Organised' : 'Summary'}
          {r.chunks && r.chunks > 1 ? ` · ${r.chunks} parts` : ''}
        </span>
        <span className="engine-ms">{(r.ms / 1000).toFixed(1)} s</span>
      </div>
      {r.task === 'organize' && (
        <dl className="intel-fields">
          <dt>Title</dt>
          <dd>{r.title || '—'}</dd>
          <dt>Project</dt>
          <dd>{r.project || 'None fits (rules decide)'}</dd>
          <dt>Tags</dt>
          <dd>{r.tags.length ? r.tags.map((t) => `#${t}`).join(' ') : '—'}</dd>
          <dt>About</dt>
          <dd>{r.summary || '—'}</dd>
          {r.actionItems.length > 0 && (
            <>
              <dt>To-dos</dt>
              <dd>
                {r.actionItems.map((a) => (
                  <div key={a}>☐ {a}</div>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}
      {r.text && <pre className="intel-body">{r.text}</pre>}
      {r.task === 'summarize' && <p className="intel-body">{r.summary}</p>}
      {r.runtime && <span className="muted small engine-runtime">{r.runtime}</span>}
    </div>
  )
}
