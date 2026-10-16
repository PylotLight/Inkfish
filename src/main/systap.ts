import { execFile, spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { app, ipcMain, type WebContents } from 'electron'
import {
  groupApps,
  parseAudioApps,
  parseSourcesLine,
  supportsAppAudio,
  tapArgs,
  type AudioApp,
  type SystemAudioSource
} from '../shared/systemAudio'
import { helperPath } from './stt'

/**
 * Audio-only system capture for meetings: the bundled helper's `tap` command
 * (Core Audio process tap, macOS 14.2+) streams the Mac's output as mono
 * Float32 PCM. Needs only "System Audio Recording Only", no screen access.
 * Chunks go to the renderer as `systap:data`; it rebuilds a MediaStream.
 *
 * A source of specific apps (`tap --apps id,…`) taps only those apps'
 * processes; the helper follows them as they restart and reports what it's
 * tapping as `SOURCES {json}` lines, forwarded as `systap:sources`.
 */
let child: ChildProcess | null = null

function stop(): void {
  if (!child) return
  child.stdin?.end()
  child.kill('SIGTERM')
  child = null
}

function start(wc: WebContents, source?: SystemAudioSource): Promise<{ rate: number } | { error: string }> {
  stop()
  const bin = helperPath()
  if (!bin) return Promise.resolve({ error: 'transcription helper not built' })
  const args = source && appAudioSupported() ? tapArgs(source) : ['tap']
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    child = p
    let settled = false
    let err = ''
    const done = (r: { rate: number } | { error: string }): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    const timer = setTimeout(() => {
      done({ error: 'system audio tap did not start (permission prompt pending?)' })
      if (child === p) stop()
    }, 10_000)
    let pending = ''
    p.stderr?.on('data', (d: Buffer) => {
      const text = d.toString()
      err = (err + text).slice(-8000)
      const m = /RATE (\d+)/.exec(err)
      if (m) {
        clearTimeout(timer)
        done({ rate: Number(m[1]) })
      }
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const l of lines) {
        const s = parseSourcesLine(l)
        if (s && !wc.isDestroyed()) wc.send('systap:sources', s)
      }
    })
    let carry: Buffer = Buffer.alloc(0)
    p.stdout?.on('data', (d: Buffer) => {
      if (wc.isDestroyed()) return stop()
      // Keep whole Float32 samples per message.
      const buf = carry.length ? Buffer.concat([carry, d]) : d
      const whole = buf.length - (buf.length % 4)
      carry = buf.subarray(whole)
      if (whole > 0) wc.send('systap:data', buf.subarray(0, whole))
    })
    p.on('error', (e) => {
      clearTimeout(timer)
      done({ error: e.message })
    })
    p.on('exit', (code) => {
      clearTimeout(timer)
      const line = err
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('RATE') && !l.startsWith('SOURCES'))
        .pop()
      done({ error: line || `system audio tap exited (${code ?? 'signal'})` })
      if (child === p) child = null
      if (!wc.isDestroyed()) wc.send('systap:ended')
    })
  })
}

/** Per-app capture needs Core Audio process taps (macOS 14.2+) and the helper. */
export function appAudioSupported(): boolean {
  return supportsAppAudio(process.platform, os.release()) && !!helperPath()
}

const icons = new Map<string, string>()

async function iconFor(path: string): Promise<string | undefined> {
  if (!path) return undefined
  const hit = icons.get(path)
  if (hit) return hit
  try {
    const img = await app.getFileIcon(path, { size: 'normal' })
    const url = img.isEmpty() ? '' : img.toDataURL()
    if (url) icons.set(path, url)
    return url || undefined
  } catch {
    return undefined
  }
}

/** Apps Core Audio knows about, grouped by owning app, playing ones first. */
function listApps(): Promise<AudioApp[] | { error: string }> {
  const bin = helperPath()
  if (!bin || !appAudioSupported()) return Promise.resolve({ error: 'per-app audio needs macOS 14.2+' })
  return new Promise((resolve) => {
    execFile(bin, ['audio-apps'], { timeout: 8000, maxBuffer: 4 << 20 }, (e, stdout, stderr) => {
      if (e) return resolve({ error: String(stderr).trim().split('\n').pop() || e.message })
      const apps = groupApps(parseAudioApps(String(stdout)))
      void Promise.all(apps.map(async (a) => ({ ...a, icon: await iconFor(a.appPath) }))).then(resolve)
    })
  })
}

export function registerSysTap(): void {
  ipcMain.handle('systap:start', (e, source?: SystemAudioSource) => start(e.sender, source))
  ipcMain.handle('systap:supported', () => appAudioSupported())
  ipcMain.handle('systap:apps', () => listApps())
  ipcMain.handle('systap:stop', () => stop())
}

export function stopSysTap(): void {
  stop()
}
