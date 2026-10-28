import type { LfmModelKey } from './lfm-catalog'

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
