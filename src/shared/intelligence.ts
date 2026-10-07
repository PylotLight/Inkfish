/**
 * Apple Intelligence (Foundation Models) contracts, shared main ↔ renderer.
 * Safe to import from any process.
 */

export type IntelTask = 'cleanup' | 'organize' | 'summarize'

/** Cleanup strength: light = punctuation + filler only; structured = also bullets/headings. */
export type IntelStyle = 'light' | 'standard' | 'structured'

export interface IntelPrefs {
  /** 'apple' = use Apple Intelligence when available; 'off' = rules engine only. */
  provider: 'apple' | 'off'
  /** Clean up captured text (filler, self-corrections, punctuation) before filing. */
  cleanup: boolean
  /** Let the model pick the title, project and tags. */
  organize: boolean
  /** Append the model's to-dos to the note as a checklist. */
  actionItems: boolean
  style: IntelStyle
  /** 0 = deterministic, 1 = most varied. */
  temperature: number
  /** Extra guidance: names, vocabulary, formatting habits. */
  instructions: string
}

export const DEFAULT_INTEL_PREFS: IntelPrefs = {
  provider: 'apple',
  cleanup: true,
  organize: true,
  actionItems: true,
  style: 'standard',
  temperature: 0.2,
  instructions: ''
}

export interface IntelStatus {
  available: boolean
  /** available | deviceNotEligible | appleIntelligenceNotEnabled | modelNotReady | osTooOld | sdkMissing | helper | unsupported | unknown */
  reason: string
  detail: string
  languages?: string[]
  runtime?: string
}

export interface IntelResult {
  task: IntelTask
  /** Cleaned note (cleanup, or organize with cleanup on). */
  text: string
  title: string
  project: string
  tags: string[]
  summary: string
  actionItems: string[]
  ms: number
  runtime: string
  chunks?: number
  provider: 'apple' | 'rules'
}

/** Messy dictation used by the Settings playground. */
export const INTEL_SAMPLE = `um so okay quick note for the inkfish thing uh we need to like ship the settings page by friday no wait thursday and um I should probably ask sam about the the icons, also remember to uh update the changelog and you know bump the version to 0.2`
