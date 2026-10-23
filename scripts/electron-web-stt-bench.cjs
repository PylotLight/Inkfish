'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(
    require('electron'),
    ['--no-sandbox', __filename, ...process.argv.slice(2)],
    { cwd: root, env, stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow } = require('electron')
const temporary = !process.env.INKFISH_STT_BENCH_PROFILE
const profile = process.env.INKFISH_STT_BENCH_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'inkfish-web-bench-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
const args = process.argv.slice(2)
const ids = args.filter((s) => s.startsWith('web-'))
if (!ids.length) {
  ids.push(
    'web-parakeet-redux',
    'web-zipformer-small',
    'web-moonshine-v2-small',
    'web-moonshine-streaming-small-en',
    'web-wav2vec2-base-960h',
    'web-moonshine-streaming-tiny-int8-experimental',
    'web-qwen3-asr-06b'
  )
}
const modes = args.includes('--smoke')
  ? ['smoke']
  : args.includes('--quick')
    ? ['quick']
    : args.includes('--deep')
      ? ['deep']
      : ['quick', 'deep']
const output = path.resolve(process.env.INKFISH_STT_BENCH_OUTPUT || path.join(root, 'bench-results.json'))
const report = {
  at: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  electron: process.versions.electron,
  offline: args.includes('--offline'),
  rows: []
}
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
let win
app
  .whenReady()
  .then(async () => {
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.webContents.on('console-message', (event) => console.log(`[renderer] ${event.message}`))
    if (report.offline) {
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) =>
        cb({ cancel: true })
      )
    }
    await win.loadFile(path.join(root, 'out/stt-bench/index.html'))
    const deadline = Date.now() + 30_000
    while (!(await win.webContents.executeJavaScript('!!window.inkfishBench'))) {
      if (Date.now() > deadline) throw new Error('Benchmark renderer did not initialize')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    let failed = false
    for (const id of ids) {
      for (const mode of modes) {
        console.log(`[bench] ${id}: ${mode} starting`)
        try {
          const row = await win.webContents.executeJavaScript(
            mode === 'smoke'
              ? `window.inkfishBench.smoke(${JSON.stringify(id)})`
              : `window.inkfishBench.run(${JSON.stringify(id)}, ${JSON.stringify(mode)})`
          )
          report.rows.push(row)
          if (mode === 'smoke') console.log(`[smoke] ${id}: ${JSON.stringify(row)}`)
          else
            console.log(
              `[bench] ${id} ${mode}: WER ${(row.wer * 100).toFixed(2)}%, ${row.speed.toFixed(2)}x real time, warm-up ${row.warmMs} ms`
            )
        } catch (error) {
          failed = true
          report.rows.push({ id, mode, error: error.message })
          console.error(`[bench] ${id} ${mode}: FAILED ${error.message}`)
          // A failed prepare/decode must not poison the following mode.
          await win.webContents.executeJavaScript(`window.inkfishBench.reset(${JSON.stringify(id)})`).catch(() => {})
        }
        save()
      }
      await win.webContents.executeJavaScript(`window.inkfishBench.reset(${JSON.stringify(id)})`)
    }
    console.log(`[bench] wrote ${output}`)
    win.destroy()
    if (temporary) fs.rmSync(profile, { recursive: true, force: true })
    app.exit(failed ? 1 : 0)
  })
  .catch((error) => {
    console.error(error)
    save()
    app.exit(1)
  })
