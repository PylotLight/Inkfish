import type { LfmModelKey } from './lfm-catalog'
import type { IntelRunStats, IntelRunUpdate, IntelThinkingLevel } from './intelligence'

export type ManagedOnnxDownloadState = 'downloading' | 'paused' | 'done' | 'error'

export interface ManagedOnnxDownloadProgress {
  modelKey: LfmModelKey
  state: ManagedOnnxDownloadState
  fraction: number
  bytes: number
  totalBytes: number
  file?: string
  error?: string
}

export interface ManagedOnnxModelStatus {
  modelKey: LfmModelKey
  modelId: string
  name: string
  installed: boolean
  downloadedBytes: number
  totalBytes: number
  /** Conservative estimate for weights, a moderate context and vision activations when applicable. */
  estimatedRamBytes: number
  progress?: ManagedOnnxDownloadProgress
}

export interface ManagedOnnxStatus {
  supportedPlatform: boolean
  platform: string
  runtimeReady: boolean
  runtimeVersion?: string
  loaded: boolean
  loadedModelKey?: LfmModelKey
  detail: string
  models: ManagedOnnxModelStatus[]
}

/** Split decoded LFM3 generation text into its reasoning trace and user-facing answer. */
export function splitLfm3ThinkingText(
  text: string,
  thinkingLevel: IntelThinkingLevel
): { thinking: string; content: string } {
  let thinking = ''
  let content = ''
  let cursor = 0
  let inThinking = thinkingLevel === 'on'
  const markers = /<\/?think>/g
  for (let match = markers.exec(text); match; match = markers.exec(text)) {
    const value = text.slice(cursor, match.index)
    if (inThinking) thinking += value
    else content += value
    inThinking = match[0] === '<think>'
    cursor = match.index + match[0].length
  }
  const tail = text.slice(cursor)
  if (inThinking) thinking += tail
  else content += tail
  const clean = (value: string): string => value.replace(/<\|[^|]+\|>/g, '')
  return { thinking: clean(thinking), content: clean(content) }
}

export type { IntelRunStats, IntelRunUpdate, IntelThinkingLevel }
