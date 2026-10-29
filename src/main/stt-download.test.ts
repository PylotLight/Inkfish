import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { cloneProxySettings, DEFAULT_PROXY_SETTINGS } from '../shared/proxy-settings'
import { proxyState } from './proxy-state'
import { clearDownload, downloadProgress, prepareEngine } from './stt'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const original = { settings: proxyState.settings, transitioning: proxyState.transitioning, blocked: proxyState.blocked }
let temp = ''
let server: ReturnType<typeof createServer> | undefined
const sockets = new Set<Socket>()
afterEach(() => {
  clearDownload('test-model')
  Object.defineProperty(process, 'platform', platformDescriptor)
  if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
  else Reflect.deleteProperty(process, 'resourcesPath')
  Object.assign(proxyState, original)
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  server?.close()
  if (temp) rmSync(temp, { recursive: true, force: true })
})

test('prepareEngine routes a helper model download through active SOCKS and cleans up the bridge', async () => {
  let destination = ''
  let request = ''
  server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let pending = Buffer.alloc(0)
    let state = 0
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      if (state === 0) {
        if (pending.length < 2 || pending.length < 2 + pending[1]!) return
        pending = pending.subarray(2 + pending[1]!)
        socket.write(Buffer.from([5, 0]))
        state = 1
      }
      if (state === 1) {
        if (pending.length < 5) return
        const length = pending[4]!
        if (pending.length < 7 + length) return
        expect(pending[3]).toBe(3)
        destination = pending.subarray(5, 5 + length).toString()
        pending = pending.subarray(7 + length)
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]))
        state = 2
      }
      if (state === 2) {
        request += pending.toString()
        pending = Buffer.alloc(0)
        if (!request.includes('\r\n\r\n')) return
        state = 3
        socket.end(
          'HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: bytes 3-7/8\r\nConnection: close\r\n\r\nmodel'
        )
      }
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  proxyState.settings = cloneProxySettings(DEFAULT_PROXY_SETTINGS)
  proxyState.settings.primary = { enabled: true, host: '127.0.0.1', port: address.port, bypassLocalNetwork: false }
  proxyState.transitioning = false
  proxyState.blocked = false
  temp = mkdtempSync(join(tmpdir(), 'inkfish-native-download-'))
  mkdirSync(join(temp, 'bin'))
  const resultFile = join(temp, 'result.json')
  // Stand in for FluidAudio's documented http_proxy hook; exercise the real
  // prepareEngine spawn/env/progress/cleanup path without macOS frameworks.
  // Interpreted by `bun` — the suite runs on bun-only machines (no node).
  writeFileSync(
    join(temp, 'bin', 'inkfish-stt'),
    `#!/usr/bin/env bun
const http = require('node:http');
const fs = require('node:fs');
const proxy = process.env.http_proxy;
if (!proxy || proxy !== process.env.https_proxy) process.exit(2);
http.get(proxy, {path:'http://download.invalid/model.bin',headers:{Range:'bytes=3-'}}, res => {
  let body=''; res.on('data', d => body+=d);
  res.on('end', () => {
    if(res.statusCode!==206 || body!=='model') process.exit(3);
    fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({proxy,body}));
    process.stderr.write('PROGRESS {"fraction":1,"phase":"downloading","files":1,"total":1}\\n');
    process.stdout.write('{"ok":true}\\n');
  });
}).on('error', () => process.exit(4));
`,
    { mode: 0o755 }
  )
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: temp })
  const progress: string[] = []
  await prepareEngine('test-model', (p) => progress.push(p.state))
  expect(destination).toBe('download.invalid')
  expect(request).toMatch(/range: bytes=3-/i)
  expect(progress).toContain('downloading')
  expect(progress.at(-1)).toBe('done')
  expect(downloadProgress().find((p) => p.id === 'test-model')).toBeUndefined()
  const { proxy } = await Bun.file(resultFile).json()
  await expect(fetch(proxy)).rejects.toThrow()
}, 10_000)
