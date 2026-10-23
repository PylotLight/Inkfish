#!/usr/bin/env node
'use strict'
// After `bunx electron-vite build`:
//   xvfb-run -a node scripts/electron-stt-smoke.cjs [--offline] [--full] [web-model-id ...]
// Downloads models into an isolated profile and runs 6 s of the bundled clip.
// Set INKFISH_STT_SMOKE_PROFILE to retain downloaded weights between runs.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const temporaryProfile = !env.INKFISH_STT_SMOKE_PROFILE
  env.INKFISH_STT_SMOKE_PROFILE ||= fs.mkdtempSync(path.join(os.tmpdir(), 'inkfish-stt-smoke-'))
  const result = spawnSync(require('electron'), ['--no-sandbox', __filename, ...process.argv.slice(2)], {
    cwd: root,
    env,
    stdio: 'inherit',
    timeout: 20 * 60_000
  })
  if (temporaryProfile) fs.rmSync(env.INKFISH_STT_SMOKE_PROFILE, { recursive: true, force: true })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = require('electron')
const profile = process.env.INKFISH_STT_SMOKE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'inkfish-stt-smoke-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
const renderer = path.join(root, 'out/renderer')
const assets = fs.readdirSync(path.join(renderer, 'assets'))
const worker = assets.find((f) => /^transformerStt\.worker-.*\.js$/.test(f))
if (!worker) throw new Error('STT worker not built; run bunx electron-vite build first')
const models = process.argv.slice(2).filter((x) => x.startsWith('web-'))
if (!models.length)
  models.push(
    'web-wav2vec2-base-960h',
    'web-moonshine-tiny',
    'web-moonshine-base',
    'web-moonshine-v2-small',
    'web-whisper-tiny-en',
    'web-whisper-base-en',
    'web-distil-whisper-small-en'
  )
const offline = process.argv.includes('--offline')
const full = process.argv.includes('--full')
const wav = fs.readFileSync(path.join(root, 'src/renderer/src/assets/bench/librispeech-1272.wav'))
// Locate data rather than assuming a 44-byte WAV header.
let dataOffset = 12
while (dataOffset < wav.length && wav.toString('ascii', dataOffset, dataOffset + 4) !== 'data') {
  dataOffset += 8 + wav.readUInt32LE(dataOffset + 4) + (wav.readUInt32LE(dataOffset + 4) % 2)
}
if (dataOffset >= wav.length) throw new Error('Missing WAV data')
const pcm = []
const audioEnd = full ? wav.length : Math.min(wav.length, dataOffset + 8 + 6 * 16000 * 2)
for (let i = dataOffset + 8; i < audioEnd; i += 2) pcm.push(wav.readInt16LE(i) / 32768)

let win
let fixture
function finish(code) {
  if (fixture) fs.rmSync(fixture, { force: true })
  app.exit(code)
}
app
  .whenReady()
  .then(async () => {
    const csp = fs
      .readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
      .match(/<meta\s+http-equiv="Content-Security-Policy"[^>]+>/)[0]
    fixture = path.join(renderer, `.stt-smoke-${process.pid}.html`)
    fs.writeFileSync(fixture, `<!doctype html><head>${csp}</head><body>STT worker smoke test</body>`)
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.webContents.on('console-message', (event) => console.log(`[renderer] ${event.message}`))
    if (offline)
      win.webContents.session.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (_details, callback) => callback({ cancel: true })
      )
    await win.loadFile(fixture)
    let failed = false
    for (const id of models) {
      console.log(`[stt] ${id}: preparing${offline ? ' (offline)' : ''}, ${pcm.length / 16000} s audio`)
      try {
        const result = await win.webContents.executeJavaScript(`(async () => {
        const worker = new Worker(${JSON.stringify(`./assets/${worker}`)}, {type: 'module'});
        let seq = 0;
        const pending = new Map();
        worker.onmessage = ({data: m}) => {
          if ('progress' in m) return;
          const p = pending.get(m.seq);
          if (!p) return;
          pending.delete(m.seq);
          if ('error' in m) p.reject(Error(m.error)); else p.resolve(m.result);
        };
        worker.onerror = (e) => { for (const p of pending.values()) p.reject(Error(e.message)); pending.clear(); };
        const request = (m) => new Promise((resolve,reject) => { const n = ++seq; pending.set(n,{resolve,reject}); worker.postMessage({...m,seq:n}); });
        const timeout = setTimeout(() => { for (const p of pending.values()) p.reject(Error('Worker smoke test timed out')); worker.terminate(); }, 10 * 60_000);
        try {
          const start = performance.now();
          await request({action:'prepare',id:${JSON.stringify(id)},mirror:''});
          const loaded = performance.now();
          const result = await request({action:'transcribe',pcm:new Float32Array(${JSON.stringify(pcm)})});
          return {...result,loadMs:Math.round(loaded-start),decodeMs:Math.round(performance.now()-loaded)};
        } finally { clearTimeout(timeout); worker.terminate(); }
      })()`)
        if (!result.text.trim()) throw new Error('Empty transcript')
        // The bundled reference has over 200 words. This deliberately loose
        // floor catches whole missing sections without pretending to score WER.
        if (full && result.text.trim().split(/\s+/).length < 150) {
          throw new Error(`Suspiciously short transcript for the full clip: ${result.text}`)
        }
        console.log(`[stt] ${id}: ${JSON.stringify(result)}`)
      } catch (error) {
        failed = true
        console.error(`[stt] ${id}: FAILED: ${error.message}`)
      }
    }
    finish(failed ? 1 : 0)
  })
  .catch((error) => {
    console.error(error)
    finish(1)
  })
