import type { LfmModelKey } from './lfm-catalog'

export type ManagedLfmDownloadState = 'downloading' | 'paused' | 'done' | 'error'

export interface ManagedLfmDownloadProgress {
  modelKey: LfmModelKey
  state: ManagedLfmDownloadState
  fraction: number
  bytes: number
  totalBytes: number
  file?: string
  error?: string
}

export interface ManagedLfmModelStatus {
  modelKey: LfmModelKey
  apiModelId: string
  name: string
  installed: boolean
  downloadedBytes: number
  totalBytes: number
  /** Conservative estimate for model weights, projector (when present), and an 8k context. */
  estimatedRamBytes: number
  progress?: ManagedLfmDownloadProgress
}

export interface ManagedLfmStatus {
  supportedPlatform: boolean
  platform: string
  binaryReady: boolean
  binaryVersion?: string
  running: boolean
  runningModelKey?: LfmModelKey
  pid?: number
  baseUrl?: string
  detail: string
  models: ManagedLfmModelStatus[]
}
