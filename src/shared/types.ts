import type { BrowserWindow } from 'electron'

/**
 * Shared contracts between main ↔ preload ↔ renderer.
 * Everything here is types only, so it is safe to import from any process.
 * Runtime values live in `./config`.
 */

/** A vibrancy material accepted by `win.setVibrancy()`. Derived from Electron's
 * own types so it can never drift from the installed version. */
export type VibrancyName = NonNullable<Parameters<BrowserWindow['setVibrancy']>[0]>

export interface SysInfo {
  platform: NodeJS.Platform
  arch: string
  release: string
  hostname: string
  cpus: number
  totalMem: number
  freeMem: number
}

export interface GlassState {
  platform: NodeJS.Platform
  vibrancy: VibrancyName | null
  transparent: boolean
}
