import { spawn, type ChildProcess } from 'node:child_process'
import { ipcMain, type WebContents } from 'electron'
import { helperPath } from './stt'

/**
 * Audio-only system capture for meetings: the bundled helper's `tap` command
 * (Core Audio process tap, macOS 14.2+) streams the Mac's output as mono
 * Float32 PCM. Needs only "System Audio Recording Only", no screen access.
 * Chunks go to the renderer as `systap:data`; it rebuilds a MediaStream.
 */
let child: ChildProcess | null = null

function stop(): void {
  if (!child) return
  child.stdin?.end()
  child.kill('SIGTERM')
  child = null
}

function start(wc: WebContents): Promise<{ rate: number } | { error: string }> {
  stop()
  const bin = helperPath()
  if (!bin) return Promise.resolve({ error: 'transcription helper not built' })
  return new Promise((resolve) => {
    const p = spawn(bin, ['tap'], { stdio: ['pipe', 'pipe', 'pipe'] })
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
    p.stderr?.on('data', (d: Buffer) => {
      err += d.toString()
      const m = /RATE (\d+)/.exec(err)
      if (m) {
        clearTimeout(timer)
        done({ rate: Number(m[1]) })
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
      const line = err.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('RATE')).pop()
      done({ error: line || `system audio tap exited (${code ?? 'signal'})` })
      if (child === p) child = null
      if (!wc.isDestroyed()) wc.send('systap:ended')
    })
  })
}

export function registerSysTap(): void {
  ipcMain.handle('systap:start', (e) => start(e.sender))
  ipcMain.handle('systap:stop', () => stop())
}

export function stopSysTap(): void {
  stop()
}
