import { useEffect, useMemo, useState } from 'react'
import type { AiProviderSettings, AiTestResult } from '../../../shared/ai-api'
import { errorDetailsText } from '../../../shared/ai-errors'
import {
  AI_API_LABEL,
  MODALITIES,
  addDiscovered,
  editModel,
  formatTokens,
  modelSubtitle,
  parseLevels,
  redetect,
  type AiModel,
  type DiscoveredModel,
  type DiscoveryResult,
  type Modality
} from '../../../shared/ai-models'
import { AI_ACTIONS, AI_ACTION_INFO, type AiAction } from '../../../shared/ai-process'
import { ipcError } from '../audio'
import CopyDetails from './CopyDetails'

/**
 * Settings › AI › Models: the models Inkfish can use with the connected provider.
 * - Find models asks the provider (from main; the key stays there) and offers what it found,
 *   with context / output / modalities / tools / reasoning prefilled where the server reports them.
 * - Add model adds an id by hand. Every field stays editable; edited fields survive Re-detect.
 * - The default model answers every action; an action can have its own.
 */

type Patch = Partial<Pick<AiProviderSettings, 'model' | 'models' | 'actionModels' | 'includeImages'>>

interface Props {
  settings: AiProviderSettings
  save: (patch: Patch) => Promise<void>
  /** Test hook / screenshot: open the picker with this result. */
  initialFound?: DiscoveryResult | null
  initialOpen?: string | null
}

function Info({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="ai-info" title={text} aria-label={text} role="img">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <rect x="7.25" y="7" width="1.5" height="4.5" rx=".75" fill="currentColor" />
        <circle cx="8" cy="4.9" r=".95" fill="currentColor" />
      </svg>
    </span>
  )
}

function numOrUndef(v: string): number | undefined {
  const n = Number(v.replace(/[_,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function CapBoxes({
  label,
  value,
  onChange
}: {
  label: string
  value: Modality[]
  onChange: (next: Modality[]) => void
}): React.JSX.Element {
  return (
    <div className="ai-model-field">
      <span className="ai-model-flabel">{label}</span>
      <div className="ai-caps" role="group" aria-label={label}>
        {MODALITIES.map((m) => (
          <label key={m} className="ai-cap">
            <input
              type="checkbox"
              checked={value.includes(m)}
              onChange={(e) => onChange(e.target.checked ? [...value, m] : value.filter((x) => x !== m))}
            />
            {m}
          </label>
        ))}
      </div>
    </div>
  )
}

function ModelRow({
  model,
  isDefault,
  open,
  onToggle,
  onChange,
  onRename,
  onDelete,
  onMakeDefault,
  kind,
  providerApi
}: {
  model: AiModel
  /** Provider kind: the API choice only applies to OpenAI-compatible servers. */
  kind: AiProviderSettings['kind']
  providerApi: AiProviderSettings['api']
  isDefault: boolean
  open: boolean
  onToggle: () => void
  onChange: (patch: Partial<AiModel>) => void
  onRename: (id: string) => string | null
  onDelete: () => void
  onMakeDefault: () => void
}): React.JSX.Element {
  const [id, setId] = useState(model.id)
  const [name, setName] = useState(model.name ?? '')
  const [ctx, setCtx] = useState(model.contextWindow ? String(model.contextWindow) : '')
  const [out, setOut] = useState(model.maxOutputTokens ? String(model.maxOutputTokens) : '')
  const [levels, setLevels] = useState((model.reasoningLevels ?? []).join(', '))
  const [idError, setIdError] = useState('')
  const [test, setTest] = useState<AiTestResult | 'running' | null>(null)
  const runTest = async (): Promise<void> => {
    setTest('running')
    try {
      setTest(await window.api.aiApi.test({ testModel: model.id }))
    } catch (e) {
      setTest({ ok: false, ms: 0, detail: ipcError(e), model: model.id })
    }
  }
  const autoUses = model.endpoint === 'responses' ? 'Responses' : 'Chat Completions'
  useEffect(() => {
    setId(model.id)
    setName(model.name ?? '')
    setCtx(model.contextWindow ? String(model.contextWindow) : '')
    setOut(model.maxOutputTokens ? String(model.maxOutputTokens) : '')
    setLevels((model.reasoningLevels ?? []).join(', '))
  }, [model])
  const subtitle = modelSubtitle(model)
  const edited: string[] = model.edited ?? []
  const mark = (f: string): string => (edited.includes(f) ? ' edited' : '')
  const input = model.input ?? ['text']
  const output = model.output ?? ['text']

  return (
    <div className={`ai-model${open ? ' open' : ''}`}>
      <div className="ai-model-head">
        <button
          className="ai-model-toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${model.id}`}
        >
          <span className="ai-chev" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
          <span className="ai-model-titles">
            <span className="ai-model-title">
              {model.name && <span className="ai-model-name">{model.name}</span>}
              <span className="ai-model-id">{model.id}</span>
              {isDefault && <span className="ai-badge">Default</span>}
            </span>
            {subtitle && <span className="ai-model-sub">{subtitle}</span>}
          </span>
        </button>
        <button
          className="btn ghost sm icon ai-model-del"
          onClick={onDelete}
          title={`Remove ${model.id}`}
          aria-label={`Remove ${model.id}`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M6 2h4l.5 1H14v1.5H2V3h3.5L6 2Zm-2.5 4h9l-.7 8.2a1 1 0 0 1-1 .8H5.2a1 1 0 0 1-1-.8L3.5 6Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      {open && (
        <div className="ai-model-body">
          <div className="ai-model-grid">
            <label className="ai-model-field">
              <span className="ai-model-flabel">Model ID</span>
              <input
                className="text-input mono"
                value={id}
                spellCheck={false}
                onChange={(e) => setId(e.target.value)}
                onBlur={() => {
                  if (id.trim() === model.id) return
                  const err = onRename(id.trim())
                  setIdError(err ?? '')
                  if (err) setId(model.id)
                }}
                aria-label="Model ID"
              />
              {idError && <span className="small error-text">{idError}</span>}
            </label>
            <label className="ai-model-field">
              <span className={`ai-model-flabel${mark('name')}`}>Model name</span>
              <input
                className="text-input"
                value={name}
                placeholder={model.id}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name !== (model.name ?? '') && onChange({ name: name.trim() || undefined })}
                aria-label="Model name"
              />
            </label>
            <label className="ai-model-field">
              <span className={`ai-model-flabel${mark('contextWindow')}`}>Context window</span>
              <input
                className="text-input"
                inputMode="numeric"
                value={ctx}
                placeholder="e.g. 128000"
                onChange={(e) => setCtx(e.target.value)}
                onBlur={() => numOrUndef(ctx) !== model.contextWindow && onChange({ contextWindow: numOrUndef(ctx) })}
                aria-label="Context window"
              />
            </label>
            <label className="ai-model-field">
              <span className={`ai-model-flabel${mark('maxOutputTokens')}`}>Max output tokens</span>
              <input
                className="text-input"
                inputMode="numeric"
                value={out}
                placeholder="e.g. 16384"
                onChange={(e) => setOut(e.target.value)}
                onBlur={() => numOrUndef(out) !== model.maxOutputTokens && onChange({ maxOutputTokens: numOrUndef(out) })}
                aria-label="Max output tokens"
              />
            </label>
            <label className="ai-model-field">
              <span className={`ai-model-flabel${mark('reasoningLevels')}`}>
                Reasoning levels <Info text="Comma-separated levels this model accepts. Leave empty for models without reasoning." />
              </span>
              <input
                className="text-input"
                value={levels}
                placeholder="low, medium, high"
                spellCheck={false}
                onChange={(e) => setLevels(e.target.value)}
                onBlur={() =>
                  levels !== (model.reasoningLevels ?? []).join(', ') && onChange({ reasoningLevels: parseLevels(levels) ?? [] })
                }
                aria-label="Reasoning levels"
              />
            </label>
            <label className="ai-model-field">
              <span className="ai-model-flabel">
                Use reasoning{' '}
                <Info text="Sent with each request (reasoning_effort, or Anthropic extended thinking). Provider default sends nothing." />
              </span>
              <select
                value={model.reasoning ?? ''}
                disabled={!model.reasoningLevels?.length}
                onChange={(e) => onChange({ reasoning: e.target.value || undefined })}
                aria-label="Use reasoning"
              >
                <option value="">Provider default</option>
                {(model.reasoningLevels ?? []).map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {kind === 'openai' && (
            <label className="ai-model-field">
              <span className="ai-model-flabel">
                API{' '}
                <Info text="Which endpoint this model is called on. Auto uses Chat Completions unless the model needs the Responses API (found by Find models, or learned when Chat Completions says it is responses-only); it then retries on /responses once and remembers it." />
              </span>
              <select
                value={model.api ?? ''}
                onChange={(e) => onChange({ api: (e.target.value || undefined) as AiModel['api'] })}
                aria-label="API"
              >
                <option value="">
                  {providerApi && providerApi !== 'auto'
                    ? `Provider default (${AI_API_LABEL[providerApi]})`
                    : `Auto (${autoUses}${model.endpoint ? (model.detected?.endpoint ? ', detected' : ', learned') : ''})`}
                </option>
                <option value="chat">Chat Completions</option>
                <option value="responses">Responses</option>
              </select>
            </label>
          )}
          <CapBoxes label="Input capabilities" value={input} onChange={(v) => onChange({ input: v })} />
          <CapBoxes label="Output capabilities" value={output} onChange={(v) => onChange({ output: v })} />
          <label className="ai-cap ai-tools">
            <input type="checkbox" checked={!!model.toolCalls} onChange={(e) => onChange({ toolCalls: e.target.checked })} />
            Tool calls
          </label>
          <div className="ai-model-foot">
            <span className="muted small">
              {model.detected ? 'Values from the provider; your edits are kept on Re-detect.' : 'Added by hand.'}
              {edited.length > 0 && ` Edited: ${edited.length}.`}
            </span>
            <span className="row">
              <button className="btn ghost sm" disabled={test === 'running'} onClick={() => void runTest()}>
                {test === 'running' ? 'Testing…' : 'Test'}
              </button>
              {!isDefault && (
                <button className="btn ghost sm" onClick={onMakeDefault}>
                  Use as default
                </button>
              )}
            </span>
          </div>
          {test && test !== 'running' && (
            <p className={`small setting-hint${test.ok ? ' muted' : ' error-text'}`} style={{ overflowWrap: 'anywhere' }}>
              {test.ok
                ? `OK in ${(test.ms / 1000).toFixed(1)} s${test.endpoint ? ` via ${test.endpoint}` : ''} · “${test.detail}”`
                : test.detail}{' '}
              {!test.ok && <CopyDetails text={errorDetailsText(test.error ?? null, test.detail, { test: true, endpoint: test.endpoint })} />}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Picker({
  result,
  have,
  onAdd,
  onRedetect,
  onClose
}: {
  result: DiscoveryResult
  have: Set<string>
  onAdd: (picked: DiscoveredModel[]) => void
  onRedetect: (force: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [force, setForce] = useState(false)
  const fresh = useMemo(() => result.models.filter((m) => !have.has(m.id)), [result, have])
  const hidden = fresh.filter((m) => m.nonChat).length
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return fresh.filter(
      (m) => (showAll || !m.nonChat) && (!s || m.id.toLowerCase().includes(s) || (m.name ?? '').toLowerCase().includes(s))
    )
  }, [fresh, q, showAll])
  const already = result.models.length - fresh.length
  const toggle = (id: string): void =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className="ai-picker" role="dialog" aria-label="Found models">
      <div className="ai-picker-head">
        <input
          className="text-input"
          value={q}
          placeholder={`Search ${fresh.length} model${fresh.length === 1 ? '' : 's'}…`}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          aria-label="Search models"
        />
        <button className="btn ghost sm" onClick={() => setPicked(new Set(shown.map((m) => m.id)))} disabled={!shown.length}>
          Select all
        </button>
      </div>
      <p className="muted small setting-hint">
        Found via {result.sources.join(', ') || 'the provider'}.{already > 0 && ` ${already} already added.`}
        {hidden > 0 && (
          <>
            {' '}
            <button className="link-btn" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Hide' : 'Show'} {hidden} embedding/other model{hidden === 1 ? '' : 's'}
            </button>
          </>
        )}
      </p>
      <div className="ai-picker-list">
        {shown.length === 0 && (
          <p className="muted small">{fresh.length ? 'No match.' : 'Every model found is already in your list.'}</p>
        )}
        {shown.map((m) => {
          const sub = modelSubtitle(m)
          return (
            <label key={m.id} className="ai-picker-item">
              <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
              <span className="ai-model-titles">
                <span className="ai-model-title">
                  {m.name && <span className="ai-model-name">{m.name}</span>}
                  <span className="ai-model-id">{m.id}</span>
                </span>
                {sub && <span className="ai-model-sub">{sub}</span>}
              </span>
            </label>
          )
        })}
      </div>
      <div className="ai-picker-foot">
        {already > 0 && (
          <span className="ai-redetect">
            <button
              className="btn ghost sm"
              onClick={() => onRedetect(force)}
              title="Update the models already in your list with what the provider reports"
            >
              Re-detect {already} added
            </button>
            <label className="ai-cap small">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              overwrite my edits
            </label>
          </span>
        )}
        <span className="ai-grow" />
        <button className="btn ghost sm" onClick={onClose}>
          Cancel
        </button>
        <button className="btn sm mint" disabled={!picked.size} onClick={() => onAdd(result.models.filter((m) => picked.has(m.id)))}>
          Add {picked.size || ''} model{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}

export default function AiModelsSettings({ settings, save, initialFound = null, initialOpen = null }: Props): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(initialOpen)
  const [finding, setFinding] = useState(false)
  const [found, setFound] = useState<DiscoveryResult | null>(initialFound)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [newId, setNewId] = useState('')
  const [notice, setNotice] = useState('')
  const models = settings.models
  const have = useMemo(() => new Set(models.map((m) => m.id)), [models])
  const perAction = AI_ACTIONS.filter((a) => settings.actionModels[a])
  const [showPerAction, setShowPerAction] = useState(perAction.length > 0)
  const active = models.find((m) => m.id === settings.model)

  const setModels = (next: AiModel[], extra: Patch = {}): void => void save({ models: next, ...extra })

  const find = async (): Promise<void> => {
    setFinding(true)
    setError('')
    setNotice('')
    try {
      const r = await window.api.aiApi.discover()
      if (r.error && !r.models.length) setError(r.error)
      else if (!r.models.length) setError('The provider answered but listed no models.')
      else setFound(r)
    } catch (e) {
      setError(ipcError(e))
    } finally {
      setFinding(false)
    }
  }

  const addManual = (): void => {
    const id = newId.trim()
    if (!id) return
    if (have.has(id)) {
      setError(`${id} is already in the list.`)
      return
    }
    setError('')
    setModels([...models, { id }])
    setNewId('')
    setAdding(false)
    setOpen(id)
  }

  const rename = (from: string, to: string): string | null => {
    if (!to) return 'Model ID cannot be empty.'
    if (to !== from && have.has(to)) return `${to} is already in the list.`
    const next = models.map((m) => (m.id === from ? { ...m, id: to } : m))
    const actionModels = Object.fromEntries(Object.entries(settings.actionModels).map(([a, id]) => [a, id === from ? to : id]))
    setModels(next, { actionModels, ...(settings.model === from ? { model: to } : {}) })
    setOpen(to)
    return null
  }

  const remove = (id: string): void => {
    const next = models.filter((m) => m.id !== id)
    if (!next.length) {
      setError('Keep at least one model.')
      return
    }
    setModels(next, settings.model === id ? { model: next[0]!.id } : {})
  }

  return (
    <section className="settings-group ai-models">
      <div className="ai-models-head">
        <h4>
          Models{' '}
          <Info text="Find models asks the connected provider for its models (GET /models, plus LiteLLM, Ollama and LM Studio details when the server offers them) and fills in context size, output limit and capabilities where it can. Everything stays editable." />
        </h4>
        <div className="ai-models-actions">
          <button className="btn ghost sm" onClick={() => void find()} disabled={finding}>
            {finding ? 'Finding…' : 'Find models'}
          </button>
          <button className="btn ghost sm" onClick={() => setAdding((v) => !v)}>
            Add model
          </button>
        </div>
      </div>

      {adding && (
        <div className="ai-add">
          <input
            className="text-input mono"
            value={newId}
            autoFocus
            spellCheck={false}
            placeholder="model id, e.g. gpt-4o-mini or llama3.2:latest"
            onChange={(e) => setNewId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addManual()
              if (e.key === 'Escape') setAdding(false)
            }}
            aria-label="New model id"
          />
          <button className="btn sm mint" disabled={!newId.trim()} onClick={addManual}>
            Add
          </button>
        </div>
      )}

      {found && (
        <Picker
          result={found}
          have={have}
          onClose={() => setFound(null)}
          onAdd={(picked) => {
            setModels(addDiscovered(models, picked))
            setNotice(`Added ${picked.length} model${picked.length === 1 ? '' : 's'}.`)
            setFound(null)
          }}
          onRedetect={(force) => {
            setModels(redetect(models, found.models, { force }))
            setNotice(force ? 'Re-detected; your edits were replaced.' : 'Re-detected; your edits were kept.')
            setFound(null)
          }}
        />
      )}
      {error && <p className="small setting-hint error-text">{error}</p>}
      {notice && <p className="small setting-hint muted">{notice}</p>}

      <div className="ai-model-list">
        {models.map((m) => (
          <ModelRow
            key={m.id}
            model={m}
            kind={settings.kind}
            providerApi={settings.api}
            isDefault={m.id === settings.model}
            open={open === m.id}
            onToggle={() => setOpen((o) => (o === m.id ? null : m.id))}
            onChange={(patch) => setModels(models.map((x) => (x.id === m.id ? editModel(x, patch) : x)))}
            onRename={(to) => rename(m.id, to)}
            onDelete={() => remove(m.id)}
            onMakeDefault={() => void save({ model: m.id })}
          />
        ))}
      </div>

      <div className="setting-row inline">
        <div className="setting-label">
          Default model
          <span className="muted small setting-hint">
            Used for every action unless one has its own.
            {active?.contextWindow ? ` Long notes are split to fit its ${formatTokens(active.contextWindow)} context.` : ''}
          </span>
        </div>
        <select value={settings.model} onChange={(e) => void save({ model: e.target.value })} aria-label="Default model">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-row stacked">
        <button className="link-btn ai-per-action-toggle" onClick={() => setShowPerAction((v) => !v)} aria-expanded={showPerAction}>
          {showPerAction ? '▾' : '▸'} Per-action models{perAction.length ? ` (${perAction.length})` : ''}
        </button>
        {showPerAction && (
          <div className="ai-per-action">
            {AI_ACTIONS.map((a: AiAction) => (
              <label key={a} className="ai-per-action-row">
                <span>{AI_ACTION_INFO[a].label.replace('…', '')}</span>
                <select
                  value={settings.actionModels[a] ?? ''}
                  onChange={(e) => {
                    const next = { ...settings.actionModels }
                    if (e.target.value) next[a] = e.target.value
                    else delete next[a]
                    void save({ actionModels: next })
                  }}
                  aria-label={`Model for ${AI_ACTION_INFO[a].label}`}
                >
                  <option value="">Default model</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="setting-row inline">
        <div className="setting-label">
          Include note images
          <span className="muted small setting-hint">
            Send a note’s images with Process actions, only to models with image input checked. Off: text only.
          </span>
        </div>
        <button
          role="switch"
          aria-checked={settings.includeImages}
          className={`switch${settings.includeImages ? ' on' : ''}`}
          onClick={() => void save({ includeImages: !settings.includeImages })}
          aria-label="Include note images"
        >
          <span className="knob" />
        </button>
      </div>
    </section>
  )
}
