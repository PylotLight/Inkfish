// Utility process (utilityProcess.fork from src/main/ai-api.ts, built as out/main/ai-handler.js):
// answers the Prompt API (`LanguageModel`) for Inkfish's own windows through the provider the user
// connected in Settings › AI. Main posts `{ type: 'config', config }` (key decrypted in main, kept
// in memory here only, never logged); `config: null` means disconnected.
import { LanguageModelUtility, localAIHandler } from 'electron/utility'
import { isAppOrigin } from '../shared/ai-api'
import { createLanguageModelClass, type LanguageModelBase } from './ai-model'
import { createProvider, modelFor, type AiProvider, type ProviderConfig } from './ai-providers'

let provider: AiProvider | null = null
let config: ProviderConfig | null = null

process.parentPort.on('message', (event) => {
  const data = event.data as { type?: string; config?: ProviderConfig | null }
  if (data?.type !== 'config') return
  config = data.config ? { ...data.config } : null
  if (config) {
    // Auto API: a model that turned out to need the other endpoint is remembered by main.
    config.onLearn = (model, endpoint) => process.parentPort.postMessage({ type: 'learned', model, endpoint })
  }
  provider = config ? createProvider(config) : null
})

const InkfishLanguageModel = createLanguageModelClass(
  LanguageModelUtility as unknown as LanguageModelBase,
  () => provider,
  (run) => (config ? modelFor(config, run) : null),
  // Scrubbed detail only (no key). Main keeps the last one for the renderer and logs it.
  (detail) => process.parentPort.postMessage({ type: 'error', detail, at: Date.now() })
)

// Set as early as possible: Electron queues Prompt API calls until this runs.
localAIHandler.setPromptAPIHandler((details) => {
  if (!isAppOrigin(details.securityOrigin)) return null
  return InkfishLanguageModel as unknown as typeof LanguageModelUtility
})
