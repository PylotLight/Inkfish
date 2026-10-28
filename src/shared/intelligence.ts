/** Embedded intelligence settings and results shared main ↔ renderer. Safe to import anywhere. */

import type { IntelRuntimeId } from './intel-runtime'

export type IntelTask = 'cleanup' | 'organize' | 'summarize'
export type IntelEngineId = 'apple' | IntelRuntimeId

/** Cleanup strength: light = punctuation + filler only; structured = also bullets/headings. */
export type IntelStyle = 'light' | 'standard' | 'structured'

/** A validated, local-only image payload for vision-capable LFM endpoints. */
export interface IntelImage {
  mime: 'image/png' | 'image/jpeg'
  /** Base64 bytes without a data-URL prefix. */
  data: string
}

export const INTEL_MAX_IMAGES = 2
export const INTEL_MAX_IMAGE_BYTES = 4 * 1024 * 1024

export interface IntelPrefs {
  /** Apple Foundation Models, a local OpenAI-compatible runtime, or rules-only fallback. */
  provider: 'apple' | 'local' | 'off'
  /** Selected engine. Apple Foundation Models remains the default. */
  engine: IntelEngineId
  /** OpenAI-compatible API root; restricted to loopback for the embedded-model path. */
  localBaseUrl: string
  /** Exact advertised ID for an LFM3 checkpoint verified for the selected runtime. */
  localModel: string
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
  engine: 'apple',
  localBaseUrl: 'http://127.0.0.1:8080/v1',
  localModel: '',
  cleanup: true,
  organize: true,
  actionItems: true,
  style: 'standard',
  temperature: 0.2,
  instructions: ''
}

export interface IntelStatus {
  available: boolean
  /** Includes local invalidModel, modelUnavailable and modelNotFound outcomes. */
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
  provider: 'apple' | 'local' | 'rules'
}

/** Messy dictation used by the Settings playground. */
export const INTEL_SAMPLE = `um so okay quick note for the inkfish thing uh we need to like ship the settings page by friday no wait thursday and um I should probably ask sam about the the icons, also remember to uh update the changelog and you know bump the version to 0.2`
