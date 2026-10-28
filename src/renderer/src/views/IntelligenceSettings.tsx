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
import { getLfmModelIdForRuntime, LFM_CATALOG, LFM_MODEL_KEYS, type LfmModelKey } from '../../../shared/lfm-catalog'
import type { ManagedLfmStatus } from '../../../shared/managed-llm'
import type { ManagedOnnxStatus } from '../../../shared/managed-onnx'
import {
  INTEL_RUNTIMES,
  intelRuntime,
  getLfmModelForRuntime,
  isSupportedLfmModelId
} from '../../../shared/intel-runtime'
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
        s.reason === 'runtimeMissing'
          ? 'The managed ONNX packages are missing. Rebuild the macOS Apple-silicon app so its verified CPU runtime is included.'
          : s.reason === 'binaryMissing'
            ? 'The pinned llama-server bundle is missing. Rebuild the macOS Apple-silicon app so its verified runtime is included.'
            : s.reason === 'platformUnsupported'
              ? engine === 'onnx-managed'
                ? 'Managed ONNX currently supports macOS Apple silicon with the CPU execution provider.'
                : engine === 'mlx-vlm'
                  ? 'MLX-VLM is experimental and requires macOS on Apple silicon (arm64), plus its separately installed pinned Python runtime.'
                  : 'The managed llama.cpp bundle currently supports macOS Apple silicon only. Other runtimes can connect to a local server.'
              : s.reason === 'modelNotDownloaded'
                ? 'Choose a model, review and accept the LFM Open License, then download the weights below.'
                : s.reason === 'invalidUrl'
                  ? 'Use a localhost, 127.0.0.1 or ::1 URL. Embedded inference will not connect to a remote host.'
                  : s.reason === 'incompatible'
                    ? 'The server answered, but its /models route did not return the expected OpenAI-compatible model list.'
                    : s.reason === 'invalidModel' || s.reason === 'modelUnavailable' || s.reason === 'modelNotFound'
                      ? 'Choose an LFM3 model supported by the selected runtime and use its exact model ID. LFM3-VL image inputs are supported through managed ONNX, llama.cpp, and experimental MLX-VLM.'
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
  const [managed, setManaged] = useState<ManagedLfmStatus | null>(null)
  const [onnxManaged, setOnnxManaged] = useState<ManagedOnnxStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [managedBusy, setManagedBusy] = useState(false)
  const [managedError, setManagedError] = useState('')
  const [licenseAccepted, setLicenseAccepted] = useState(false)
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
      const [nextStatus, nextManaged, nextOnnx] = await Promise.all([
        window.api.intel.status(fresh),
        window.api.intel.managedStatus(),
        window.api.intel.onnxStatus()
      ])
      setStatus(nextStatus)
      setManaged(nextManaged)
      setOnnxManaged(nextOnnx)
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

  useEffect(
    () =>
      window.api.intel.onManagedProgress((progress) => {
        setManaged((previous) =>
          previous
            ? {
                ...previous,
                models: previous.models.map((model) =>
                  model.modelKey === progress.modelKey
                    ? {
                        ...model,
                        progress,
                        downloadedBytes: progress.bytes,
                        installed: progress.state === 'done' || model.installed
                      }
                    : model
                )
              }
            : previous
        )
      }),
    []
  )

  useEffect(
    () =>
      window.api.intel.onOnnxProgress((progress) => {
        setOnnxManaged((previous) =>
          previous
            ? {
                ...previous,
                models: previous.models.map((model) =>
                  model.modelKey === progress.modelKey
                    ? {
                        ...model,
                        progress,
                        downloadedBytes: progress.bytes,
                        installed: progress.state === 'done' || model.installed
                      }
                    : model
                )
              }
            : previous
        )
      }),
    []
  )

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
  const isManaged = prefs.engine === 'llama.cpp-managed'
  const isOnnxManaged = prefs.engine === 'onnx-managed'
  const isManagedEngine = isManaged || isOnnxManaged
  const managedModelKey = (LFM_MODEL_KEYS.find((key) => LFM_CATALOG[key].apiModelId === prefs.localModel) ??
    'lfm3-1.7b') as LfmModelKey
  const managedModel = managed?.models.find((model) => model.modelKey === managedModelKey)
  const managedProgress = managedModel?.progress
  const onnxModelKey = (getLfmModelForRuntime('onnx-managed', prefs.localModel)?.key ?? 'lfm3-1.7b') as LfmModelKey
  const onnxModel = onnxManaged?.models.find((model) => model.modelKey === onnxModelKey)
  const onnxProgress = onnxModel?.progress
  const mlxModelKey = (getLfmModelForRuntime('mlx-vlm', prefs.localModel)?.key ?? 'lfm3-1.7b') as LfmModelKey

  const runManagedAction = async (action: () => Promise<ManagedLfmStatus>): Promise<void> => {
    setManagedBusy(true)
    setManagedError('')
    try {
      setManaged(await action())
      await check(true)
    } catch (e) {
      setManagedError(ipcError(e))
      try {
        setManaged(await window.api.intel.managedStatus())
      } catch {
        // Keep the actionable error from the failed operation.
      }
    } finally {
      setManagedBusy(false)
    }
  }

  const downloadManagedModel = (): void => {
    setManagedError('')
    void window.api.intel
      .downloadManagedModel(managedModelKey, licenseAccepted)
      .then((next) => {
        setManaged(next)
        return check(true)
      })
      .catch((e) => {
        setManagedError(ipcError(e))
        void window.api.intel
          .managedStatus()
          .then(setManaged)
          .catch(() => undefined)
      })
  }

  const runOnnxAction = async (action: () => Promise<ManagedOnnxStatus>): Promise<void> => {
    setManagedBusy(true)
    setManagedError('')
    try {
      setOnnxManaged(await action())
      await check(true)
    } catch (e) {
      setManagedError(ipcError(e))
      try {
        setOnnxManaged(await window.api.intel.onnxStatus())
      } catch {
        // Keep the actionable error from the failed operation.
      }
    } finally {
      setManagedBusy(false)
    }
  }

  const downloadOnnxModel = (): void => {
    setManagedError('')
    setManagedBusy(true)
    void window.api.intel
      .downloadOnnxModel(onnxModelKey, licenseAccepted)
      .then((next) => {
        setOnnxManaged(next)
        return check(true)
      })
      .catch((e) => {
        setManagedError(ipcError(e))
        void window.api.intel
          .onnxStatus()
          .then(setOnnxManaged)
          .catch(() => undefined)
      })
      .finally(() => setManagedBusy(false))
  }

  const selectEngine = (engine: IntelEngineId): void => {
    const patch: Partial<IntelPrefs> = {
      engine,
      provider: prefs.provider === 'off' ? 'off' : engine === 'apple' ? 'apple' : 'local'
    }
    if (engine !== 'apple') {
      if (engine === 'llama.cpp-managed') {
        if (!LFM_MODEL_KEYS.some((key) => LFM_CATALOG[key].apiModelId === prefs.localModel))
          patch.localModel = LFM_CATALOG['lfm3-1.7b'].apiModelId
      } else if (engine === 'onnx-managed') {
        const current = getLfmModelForRuntime(engine, prefs.localModel)
        patch.localModel = (current?.onnx ?? LFM_CATALOG['lfm3-1.7b'].onnx)!.modelId
      } else {
        const current = getLfmModelForRuntime(engine, prefs.localModel)
        if (!current?.modalities.includes('text')) patch.localModel = intelRuntime(engine).modelExample
      }
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
          Choose Apple Foundation Models, a managed local llama.cpp or ONNX Runtime, or a loopback endpoint (including
          experimental MLX-VLM). Inkfish never sends embedded-model requests to a remote host.
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

        {selectedRuntime && !isManagedEngine && (
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
            {prefs.engine === 'mlx-vlm' ? (
              <label className="field">
                <span>MLX-VLM checkpoint</span>
                <select
                  value={mlxModelKey}
                  onChange={(e) => {
                    const key = e.target.value as LfmModelKey
                    update({ localModel: getLfmModelIdForRuntime(key, 'mlx-vlm')! }, true)
                  }}
                  aria-label="MLX-VLM checkpoint"
                >
                  {LFM_MODEL_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {LFM_CATALOG[key].name} · {key === 'lfm3-vl-2b' ? 'text + document images' : 'text documents'}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                <span>
                  Local model ID <span className="muted small">(required; must match /models)</span>
                </span>
                <input
                  value={prefs.localModel}
                  onChange={(e) => update({ localModel: e.target.value }, true)}
                  aria-label="Local model ID"
                  placeholder={selectedRuntime.modelExample}
                />
              </label>
            )}
            <p className="muted small setting-hint">
              {selectedRuntime.hint} Format: {selectedRuntime.formats}. {selectedRuntime.platform}.
            </p>
          </>
        )}

        {isManaged && (
          <div className="setting-row stacked" aria-label="Managed LFM3 model controls">
            <label className="field">
              <span>Managed LFM3 model</span>
              <select
                value={managedModelKey}
                onChange={(e) => {
                  const key = e.target.value as LfmModelKey
                  update({ localModel: LFM_CATALOG[key].apiModelId })
                  void check(true)
                }}
                aria-label="Managed LFM3 model"
              >
                {LFM_MODEL_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {LFM_CATALOG[key].name} · {key === 'lfm3-vl-2b' ? 'document images' : 'text documents'}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small setting-hint">
              Model weights are downloaded to Inkfish app data only when requested. The selected model uses about{' '}
              {managedModel
                ? (managedModel.estimatedRamBytes / 1e9).toFixed(1)
                : managedModelKey === 'lfm3-vl-2b'
                  ? '6.0'
                  : '4.0'}{' '}
              GB RAM at an 8k context; actual use varies by device. Disk download: approximately{' '}
              {managedModel
                ? (managedModel.totalBytes / 1e9).toFixed(2)
                : managedModelKey === 'lfm3-vl-2b'
                  ? '1.30'
                  : '1.10'}{' '}
              GB. Image captures use LFM3-VL-2B when its weights are installed.
            </p>
            <p className="muted small setting-hint">
              Review the{' '}
              <button className="btn link sm" onClick={() => void window.api.intel.openModelLicense()}>
                LFM Open License v1.0
              </button>{' '}
              before downloading. Its commercial-use terms include an annual-revenue threshold; read the full license
              for applicable conditions.
            </p>
            <label className="setting-row inline">
              <input
                type="checkbox"
                checked={licenseAccepted}
                onChange={(e) => setLicenseAccepted(e.target.checked)}
                aria-label="I have read and accept the LFM Open License"
              />
              <span className="setting-label">I have read and accept the LFM Open License for this download.</span>
            </label>
            {managedProgress && (
              <div className="setting-row stacked" aria-live="polite">
                <progress value={managedProgress.fraction} max={1} aria-label="Model download progress" />
                <span className="muted small">
                  {managedProgress.state === 'downloading'
                    ? `Downloading ${managedProgress.file ?? ''} · ${(managedProgress.bytes / 1e9).toFixed(2)} / ${(managedProgress.totalBytes / 1e9).toFixed(2)} GB`
                    : managedProgress.state === 'paused'
                      ? 'Download paused; resume to continue.'
                      : managedProgress.state === 'error'
                        ? managedProgress.error
                        : 'Model download and integrity checks complete.'}
                </span>
              </div>
            )}
            {managedError && <p className="small setting-hint error-text">{managedError}</p>}
            <div className="row">
              <button
                className="btn ghost sm"
                disabled={
                  !licenseAccepted ||
                  managedProgress?.state === 'downloading' ||
                  managedModel?.installed ||
                  !managed?.supportedPlatform ||
                  !managed?.binaryReady
                }
                onClick={downloadManagedModel}
              >
                {managedProgress?.state === 'paused'
                  ? 'Resume download'
                  : managedProgress?.state === 'error'
                    ? 'Retry download'
                    : 'Download model'}
              </button>
              {managedProgress?.state === 'downloading' && (
                <button
                  className="btn ghost sm"
                  disabled={managedBusy}
                  onClick={() => void runManagedAction(() => window.api.intel.pauseManagedDownload(managedModelKey))}
                >
                  Pause
                </button>
              )}
              <button
                className="btn ghost sm"
                disabled={
                  managedBusy ||
                  !managedModel?.installed ||
                  (managed?.running && managed.runningModelKey === managedModelKey)
                }
                onClick={() => void runManagedAction(() => window.api.intel.startManagedModel(managedModelKey))}
              >
                {managed?.running ? 'Switch model' : 'Start local server'}
              </button>
              <button
                className="btn ghost sm"
                disabled={managedBusy || !managed?.running}
                onClick={() => void runManagedAction(() => window.api.intel.stopManaged())}
              >
                Stop server
              </button>
              <button
                className="btn ghost sm"
                disabled={managedBusy || !managedModel?.installed}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${managedModel?.name} weights from this device? You can download them again later.`
                    )
                  )
                    void runManagedAction(() => window.api.intel.removeManagedModel(managedModelKey))
                }}
              >
                Remove model
              </button>
            </div>
            {managed && <p className="muted small setting-hint">{managed.detail}</p>}
            {managed?.running && managed.baseUrl && (
              <p className="muted small setting-hint">
                Benchmark endpoint: <code>{managed.baseUrl}</code>
                {managed.pid ? ` · Server PID ${managed.pid}` : ''}
              </p>
            )}
          </div>
        )}

        {isOnnxManaged && (
          <div className="setting-row stacked" aria-label="Managed ONNX LFM3 model controls">
            <label className="field">
              <span>Managed LFM3 ONNX model</span>
              <select
                value={onnxModelKey}
                onChange={(e) => {
                  const key = e.target.value as LfmModelKey
                  update({ localModel: LFM_CATALOG[key].onnx!.modelId })
                  void check(true)
                }}
                aria-label="Managed ONNX model"
              >
                {LFM_MODEL_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {LFM_CATALOG[key].name} · {key === 'lfm3-vl-2b' ? 'text and document images' : 'text documents'}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small setting-hint">
              Runs locally with ONNX Runtime CPU on macOS Apple silicon. Estimated RAM: about{' '}
              {onnxModel
                ? (onnxModel.estimatedRamBytes / 1e9).toFixed(1)
                : onnxModelKey === 'lfm3-vl-2b'
                  ? '6.5'
                  : '4.5'}{' '}
              GB; download: approximately{' '}
              {onnxModel ? (onnxModel.totalBytes / 1e9).toFixed(2) : onnxModelKey === 'lfm3-vl-2b' ? '1.71' : '1.64'}{' '}
              GB. The VL package includes a Q4 decoder and Q8 vision encoder; images stay on this device.
            </p>
            <p className="muted small setting-hint">
              Review the{' '}
              <button className="btn link sm" onClick={() => void window.api.intel.openModelLicense()}>
                LFM Open License v1.0
              </button>{' '}
              before downloading; its commercial-use terms include an annual-revenue threshold. Read the full license
              for applicable conditions.
            </p>
            <label className="setting-row inline">
              <input
                type="checkbox"
                checked={licenseAccepted}
                onChange={(e) => setLicenseAccepted(e.target.checked)}
                aria-label="I have read and accept the LFM Open License for ONNX downloads"
              />
              <span className="setting-label">I have read and accept the LFM Open License for this download.</span>
            </label>
            {onnxProgress && (
              <div className="setting-row stacked" aria-live="polite">
                <progress value={onnxProgress.fraction} max={1} aria-label="ONNX model download progress" />
                <span className="muted small">
                  {onnxProgress.state === 'downloading'
                    ? `Downloading ${onnxProgress.file ?? ''} · ${(onnxProgress.bytes / 1e9).toFixed(2)} / ${(onnxProgress.totalBytes / 1e9).toFixed(2)} GB`
                    : onnxProgress.state === 'paused'
                      ? 'Download paused; resume to continue.'
                      : onnxProgress.state === 'error'
                        ? onnxProgress.error
                        : 'ONNX model download and integrity checks complete.'}
                </span>
              </div>
            )}
            {managedError && <p className="small setting-hint error-text">{managedError}</p>}
            <div className="row">
              <button
                className="btn ghost sm"
                disabled={
                  managedBusy ||
                  !licenseAccepted ||
                  onnxProgress?.state === 'downloading' ||
                  onnxModel?.installed ||
                  !onnxManaged?.supportedPlatform ||
                  !onnxManaged?.runtimeReady
                }
                onClick={downloadOnnxModel}
              >
                {onnxProgress?.state === 'paused'
                  ? 'Resume download'
                  : onnxProgress?.state === 'error'
                    ? 'Retry download'
                    : 'Download model'}
              </button>
              {onnxProgress?.state === 'downloading' && (
                <button
                  className="btn ghost sm"
                  disabled={managedBusy}
                  onClick={() => void runOnnxAction(() => window.api.intel.pauseOnnxDownload(onnxModelKey))}
                >
                  Pause
                </button>
              )}
              <button
                className="btn ghost sm"
                disabled={
                  managedBusy ||
                  !onnxModel?.installed ||
                  !onnxManaged?.supportedPlatform ||
                  !onnxManaged?.runtimeReady ||
                  (onnxManaged.loaded && onnxManaged.loadedModelKey === onnxModelKey)
                }
                onClick={() => void runOnnxAction(() => window.api.intel.loadOnnxModel(onnxModelKey))}
              >
                {onnxManaged?.loaded && onnxManaged.loadedModelKey !== onnxModelKey ? 'Switch model' : 'Load model'}
              </button>
              <button
                className="btn ghost sm"
                disabled={managedBusy || !onnxManaged?.loaded}
                onClick={() => void runOnnxAction(() => window.api.intel.unloadOnnx())}
              >
                Unload model
              </button>
              <button
                className="btn ghost sm"
                disabled={managedBusy || !onnxModel?.installed}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${onnxModel?.name} ONNX files from this device? You can download them again later.`
                    )
                  )
                    void runOnnxAction(() => window.api.intel.removeOnnxModel(onnxModelKey))
                }}
              >
                Remove model
              </button>
            </div>
            {onnxManaged && <p className="muted small setting-hint">{onnxManaged.detail}</p>}
            {onnxManaged?.loaded && (
              <p className="muted small setting-hint">
                The model runs in Inkfish's main process; no local HTTP server is opened.
              </p>
            )}
          </div>
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
              ) : isOnnxManaged ? (
                <>
                  <span className="tag">On-device · ONNX Runtime CPU</span>
                  <span className="tag dim">{selectedRuntime?.formats}</span>
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
              {checking
                ? 'Checking…'
                : prefs.engine === 'apple'
                  ? 'Check again'
                  : isManagedEngine
                    ? 'Check model'
                    : 'Check connection'}
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
