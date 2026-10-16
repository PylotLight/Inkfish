import { useEffect, useState } from 'react'
import {
  AI_PROVIDER_KINDS,
  DEFAULT_AI_SETTINGS,
  DEFAULT_BASE_URL,
  isLoopbackUrl,
  type AiApiStatus,
  type AiProviderKind,
  type AiProviderSettings,
  type AiTestResult
} from '../../../shared/ai-api'
import { ipcError } from '../audio'
import AiModelsSettings from './AiModelsSettings'

const KIND_LABEL: Record<AiProviderKind, string> = {
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic'
}

const KIND_HINT: Record<AiProviderKind, string> = {
  openai: 'OpenAI, OpenRouter, Groq, or a local server such as Ollama (http://127.0.0.1:11434/v1) or LM Studio.',
  anthropic: 'Claude through the Anthropic Messages API.'
}

/**
 * Settings › AI provider. The provider answers Inkfish's Prompt API (Electron 45 local AI handler)
 * for the Processed view and Process selection. Off until connected; the key is kept in the OS
 * keychain (safeStorage) and never shown again.
 */
export default function AiApiSettings(): React.JSX.Element {
  const [status, setStatus] = useState<AiApiStatus | null>(null)
  const [form, setForm] = useState<AiProviderSettings>(DEFAULT_AI_SETTINGS)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<AiTestResult | { running: true } | null>(null)
  const [error, setError] = useState('')

  const adopt = (s: AiApiStatus): void => {
    setStatus(s)
    setForm(s.settings)
  }

  useEffect(() => {
    void window.api.aiApi
      .status()
      .then(adopt)
      .catch((e: unknown) => setError(ipcError(e)))
  }, [])

  const save = async (patch: Partial<AiProviderSettings>): Promise<void> => {
    setError('')
    try {
      adopt(await window.api.aiApi.set(patch))
    } catch (e) {
      setError(ipcError(e))
    }
  }

  const pickKind = (kind: AiProviderKind): void => {
    // Switching provider resets the URL to that provider's default unless the user had a custom one.
    // Main keeps each provider's model list and restores it when switching back.
    const next = {
      kind,
      baseUrl: form.baseUrl === DEFAULT_BASE_URL[form.kind] ? DEFAULT_BASE_URL[kind] : form.baseUrl
    }
    setForm((f) => ({ ...f, ...next }))
    void save(next)
  }

  const saveKey = async (): Promise<void> => {
    if (!key.trim()) return
    setBusy(true)
    setError('')
    try {
      adopt(await window.api.aiApi.setKey(key))
      setKey('')
      setTest({ running: true })
      setTest(await window.api.aiApi.test())
    } catch (e) {
      setError(ipcError(e))
      setTest(null)
    } finally {
      setBusy(false)
    }
  }

  const runTest = async (): Promise<void> => {
    setTest({ running: true })
    try {
      setTest(await window.api.aiApi.test({ kind: form.kind, baseUrl: form.baseUrl }))
    } catch (e) {
      setTest({ ok: false, ms: 0, detail: ipcError(e) })
    }
  }

  const connected = status?.connected ?? false
  const loopback = isLoopbackUrl(form.baseUrl)
  const keyNeeded = !status?.hasKey && !loopback

  return (
    <>
      <section className="settings-group">
        <h4>AI provider</h4>
        <p className="muted small setting-hint" style={{ marginTop: 0 }}>
          Connect an AI service to process notes: tidy formatting, fix typos, summarise, make checklists, or follow your
          own instruction. Nothing runs unless you ask for it in a note (✦, ⇧⌥P, or select text and ⇧⌥S), and your raw note
          only changes when you choose Apply or Accept.
        </p>

        <div className="setting-row inline">
          <div className="setting-label">
            Use AI provider
            <span className="muted small setting-hint">
              {connected
                ? `Connected · ${KIND_LABEL[form.kind]} · ${form.model || 'server default model'}`
                : keyNeeded
                  ? 'Add an API key below to connect.'
                  : 'Off. Nothing is sent anywhere.'}
            </span>
          </div>
          <button
            role="switch"
            aria-checked={form.enabled}
            className={`switch${form.enabled ? ' on' : ''}`}
            onClick={() => void save({ enabled: !form.enabled })}
            aria-label="Use AI provider"
          >
            <span className="knob" />
          </button>
        </div>

        <div className="setting-row stacked">
          <span className="setting-label">Provider</span>
          <div className="seg-row" role="radiogroup" aria-label="Provider">
            {AI_PROVIDER_KINDS.map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={form.kind === k}
                className={`seg${form.kind === k ? ' selected' : ''}`}
                onClick={() => pickKind(k)}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <p className="muted small setting-hint">{KIND_HINT[form.kind]}</p>
        </div>

        <div className="setting-row stacked">
          <span className="setting-label">Base URL</span>
          <input
            className="text-input"
            value={form.baseUrl}
            spellCheck={false}
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            onBlur={() => void save({ baseUrl: form.baseUrl })}
            placeholder={DEFAULT_BASE_URL[form.kind]}
            aria-label="Base URL"
          />
          {loopback && <p className="muted small setting-hint">Local server: no API key needed.</p>}
        </div>

        <div className="setting-row stacked">
          <span className="setting-label">
            API key
            <span className="muted small setting-hint">
              {status?.hasKey
                ? 'Saved in your keychain. Paste a new one to replace it.'
                : status && !status.keychain
                  ? 'The OS keychain is unavailable, so a key cannot be saved on this machine.'
                  : 'Stored encrypted in your keychain, never shown again.'}
            </span>
          </span>
          <div className="row">
            <input
              className="text-input"
              type="password"
              value={key}
              autoComplete="off"
              spellCheck={false}
              placeholder={status?.hasKey ? '••••••••  (saved)' : form.kind === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey()
              }}
              aria-label="API key"
            />
            <button className="btn sm mint" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
              {busy ? 'Saving…' : 'Save key'}
            </button>
            {status?.hasKey && (
              <button
                className="btn ghost sm"
                onClick={() =>
                  void window.api.aiApi
                    .clearKey()
                    .then(adopt)
                    .catch((e: unknown) => setError(ipcError(e)))
                }
              >
                Remove
              </button>
            )}
          </div>
        </div>

        <div className="setting-row inline">
          <div className="setting-label">
            Test connection
            <span className="muted small setting-hint">
              {test && 'running' in test
                ? 'Testing…'
                : test
                  ? test.ok
                    ? `OK in ${(test.ms / 1000).toFixed(1)} s · “${test.detail}”`
                    : test.detail
                  : 'Sends one tiny request to the default model.'}
            </span>
          </div>
          <button
            className="btn ghost sm"
            disabled={!!test && 'running' in test}
            onClick={() => void runTest()}
          >
            {test && 'running' in test ? 'Testing…' : 'Test'}
          </button>
        </div>
        {error && (
          <p className="small setting-hint error-text" style={{ overflowWrap: 'anywhere' }}>
            {error}
          </p>
        )}
      </section>

      <AiModelsSettings settings={form} save={save} />

      <section className="settings-group">
        <h4>Coming later</h4>
        <p className="muted small setting-hint" style={{ marginTop: 0 }}>
          On-device models embedded in Inkfish. Apple Intelligence filing stays in its own tab.
        </p>
      </section>
    </>
  )
}
