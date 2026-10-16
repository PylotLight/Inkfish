import { AI_PROVIDER_KINDS, DEFAULT_MODEL, parseAiSettings, type AiProviderKind, type AiProviderSettings } from '../shared/ai-api'

/**
 * The shape of `ai-provider.json` and the pure rules for changing it (Electron-free, unit-tested).
 * src/main/ai-api.ts does the file IO and keychain.
 */

/** A provider's model list, kept while another provider is selected (switching back restores it). */
export type KindStash = Pick<AiProviderSettings, 'model' | 'models' | 'actionModels'>

export interface StoredAi extends AiProviderSettings {
  /** safeStorage ciphertext, base64. */
  keyEnc?: string
  byKind?: Partial<Record<AiProviderKind, KindStash>>
}

export function settingsOnly(s: StoredAi): AiProviderSettings {
  return {
    enabled: s.enabled,
    kind: s.kind,
    baseUrl: s.baseUrl,
    model: s.model,
    models: s.models,
    actionModels: s.actionModels,
    includeImages: s.includeImages,
    api: s.api
  }
}

function parseStash(v: unknown): StoredAi['byKind'] {
  if (typeof v !== 'object' || v === null) return undefined
  const out: Partial<Record<AiProviderKind, KindStash>> = {}
  for (const k of AI_PROVIDER_KINDS) {
    const raw = (v as Record<string, unknown>)[k]
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const parsed = parseAiSettings({ kind: k, model: r.model, models: Array.isArray(r.models) ? r.models : [], actionModels: r.actionModels ?? {} })
    out[k] = { model: parsed.model, models: parsed.models, actionModels: parsed.actionModels }
  }
  return out
}

/** Read `ai-provider.json` (any version: pre-Models files only had `model`, which migrates). */
export function parseStoredAi(raw: unknown): StoredAi {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const keyEnc = typeof r.keyEnc === 'string' && r.keyEnc ? r.keyEnc : undefined
  const byKind = parseStash(r.byKind)
  return { ...parseAiSettings(r), ...(keyEnc ? { keyEnc } : {}), ...(byKind ? { byKind } : {}) }
}

/**
 * Apply a settings patch from the renderer. Switching provider kind stashes the current model list
 * under the old kind and restores the new kind's (or its default model), unless the patch brings
 * its own list. The key ciphertext is never touched here.
 */
export function applySettingsPatch(cur: StoredAi, patch: unknown): StoredAi {
  const p: Record<string, unknown> = typeof patch === 'object' && patch !== null ? { ...(patch as Record<string, unknown>) } : {}
  let base = settingsOnly(cur)
  let byKind = cur.byKind
  const kind = AI_PROVIDER_KINDS.includes(p.kind as AiProviderKind) ? (p.kind as AiProviderKind) : cur.kind
  if (kind !== cur.kind) {
    byKind = { ...byKind, [cur.kind]: { model: cur.model, models: cur.models, actionModels: cur.actionModels } }
    const back: KindStash = byKind[kind] ?? { model: DEFAULT_MODEL[kind], models: [{ id: DEFAULT_MODEL[kind] }], actionModels: {} }
    base = { ...base, kind, ...back }
    // The patch's `model` (the UI's guess before it knew about the stash) yields to the stash.
    if (byKind[kind] && !Array.isArray(p.models)) delete p.model
  }
  const next = parseAiSettings(p, base)
  return { ...next, ...(cur.keyEnc ? { keyEnc: cur.keyEnc } : {}), ...(byKind ? { byKind } : {}) }
}
