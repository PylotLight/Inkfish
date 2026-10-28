// Electron smoke for the main window / capture popover lifecycle (fix/window-lifecycle).
// Launches the BUILT app with a throwaway userData and drives its main process over the
// inspector, so no test hooks ship in the app:
//   1. capture popover open → Esc → popover hides, main window stays hidden
//   2. main window closed (destroyed) → Dock click (`activate`) → a main window exists again
//      (the old handler only made one when there were zero windows, and the popover always counts)
//   3. main window dragged far off screen + hidden → `activate` → it comes back on a display
//   4. closed again → second launch (`second-instance`) → back again
//   5. Settings › Shortcuts IPC: bare key refused, capture saved to shortcuts.json, daily on the same keys refused, '' turns off
//   bun run build && bun run test:electron-window      (Linux runs it with --ozone-platform=headless)
// Linux can't show the macOS half of the bug (app activation raising every window) — that needs a Mac check.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const userData = mkdtempSync(join(tmpdir(), 'inkfish-window-smoke-'))
const port = 9300 + Math.floor(Math.random() * 500)
// --inspect must come before the app path, or Electron hands it to the app as a plain arg.
const args = [
  `--inspect=127.0.0.1:${port}`,
  join(root, 'out/main/index.js'),
  `--user-data-dir=${userData}`,
  '--no-sandbox'
]
if (process.platform === 'linux') args.push('--ozone-platform=headless')
const child = spawn(electron, args, {
  cwd: root,
  env: { ...process.env, INKFISH_SHORTCUTS: 'off' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
const keep = (d) => {
  for (const line of String(d).split('\n'))
    if (line.includes('[inkfish]') || line.includes('[window]') || line.includes('Error')) log += line + '\n'
}
child.stdout.on('data', keep)
child.stderr.on('data', keep)

// Talk to the local inspector directly, never through an HTTP(S)_PROXY from the environment.
process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (msg) => {
  console.log(`WINDOW SMOKE FAIL: ${msg}\n--- app log ---\n${log.slice(-4000)}`)
  child.kill('SIGKILL')
  rmSync(userData, { recursive: true, force: true })
  process.exit(1)
}
const timer = setTimeout(() => fail('timeout'), 60000)

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (list[0]?.webSocketDebuggerUrl) return list[0].webSocketDebuggerUrl
    } catch {
      // DevTools is not ready yet; retry until the deadline.
    }
    await sleep(200)
  }
  fail('no inspector')
}

const ws = new WebSocket(await connect())
await new Promise((r, j) => {
  ws.onopen = r
  ws.onerror = j
})
let nextId = 1
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = nextId++
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
/** Evaluate in the app's main process; `E` is require('electron'). Returns the JSON value. */
async function main(expr) {
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { const E = require('electron'); ${expr} })()`,
    includeCommandLineAPI: true,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.result?.exceptionDetails) fail(`eval threw: ${JSON.stringify(res.result.exceptionDetails).slice(0, 800)}`)
  return res.result?.result?.value
}
// Helpers defined once in the main process.
const HELPERS = `
  globalThis.__smoke = {
    pop: () => E.BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#capture')),
    main: () => E.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() && !w.webContents.getURL().includes('#')),
    wait: async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) } return null }
  }
  return true`
await send('Runtime.enable')
for (let i = 0; i < 100; i++) {
  if (await main(`return E.app.isReady() && E.BrowserWindow.getAllWindows().length >= 2`)) break
  await sleep(200)
}
await main(HELPERS)

const step = (name) => console.log(`· ${name}`)

step('main window shows on launch')
if (!(await main(`return !!(await __smoke.wait(() => __smoke.main()?.isVisible()))`))) fail('main window never showed')

step('send to background hides the main window; Show Inkfish restores it without changing global shortcuts')
const background = await main(`
  const m = __smoke.main()
  const shortcutsBefore = await m.webContents.executeJavaScript('window.api.shortcuts.get()')
  await m.webContents.executeJavaScript('window.api.menubar.background()')
  const hidden = await __smoke.wait(() => !m.isVisible())
  const shortcutsAfter = await m.webContents.executeJavaScript('window.api.shortcuts.get()')
  E.app.emit('activate')
  const restored = await __smoke.wait(() => m.isVisible())
  return {
    hidden: !!hidden,
    restored: !!restored,
    shortcutsBefore: shortcutsBefore.registered,
    shortcutsAfter: shortcutsAfter.registered
  }`)
if (!background.hidden) fail('send to background left the main window visible')
if (!background.restored) fail('Show Inkfish did not restore the hidden main window')
if (JSON.stringify(background.shortcutsBefore) !== JSON.stringify(background.shortcutsAfter))
  fail(`background mode changed global shortcuts: ${JSON.stringify(background)}`)

step('capture popover → Esc hides it and the main window stays hidden')
const esc = await main(`
  const m = __smoke.main(); m.hide()
  const p = __smoke.pop()
  await __smoke.wait(() => !p.webContents.isLoading())
  p.show(); p.focus(); p.webContents.focus()
  await new Promise((r) => setTimeout(r, 500))
  p.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  p.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  const hidden = await __smoke.wait(() => !p.isVisible(), 5000)
  await new Promise((r) => setTimeout(r, 300))
  return { popHidden: !!hidden, mainVisible: m.isVisible() }`)
if (!esc.popHidden) fail('Esc did not hide the popover')
if (esc.mainVisible) fail('Esc on the popover showed the main window')

step('main window closed → activate (Dock click) brings one back')
const reopened = await main(`
  const m = __smoke.main(); m.close()
  await __smoke.wait(() => m.isDestroyed())
  E.app.emit('activate')
  const n = await __smoke.wait(() => { const w = __smoke.main(); return w && w !== m && w.isVisible() ? w : null })
  return !!n`)
if (!reopened) fail('activate did not recreate the main window (popover counted as a window?)')

step('off-screen main window → activate puts it back on a display')
const onScreen = await main(`
  const m = __smoke.main()
  m.setBounds({ x: -30000, y: -30000, width: 1000, height: 700 })
  m.hide()
  E.app.emit('activate')
  await __smoke.wait(() => m.isVisible())
  const b = m.getBounds()
  const areas = E.screen.getAllDisplays().map((d) => d.workArea)
  const ok = areas.some((a) => b.x >= a.x && b.y >= a.y && b.x < a.x + a.width && b.y < a.y + a.height)
  return { ok, b, areas, visible: m.isVisible() }`)
if (!onScreen.visible) fail('activate did not show the hidden main window')
if (!onScreen.ok) fail(`main window still off screen: ${JSON.stringify(onScreen)}`)

step('closed again → second launch brings it back')
const second = await main(`
  const m = __smoke.main(); m.close()
  await __smoke.wait(() => m.isDestroyed())
  E.app.emit('second-instance', {}, [], process.cwd())
  return !!(await __smoke.wait(() => { const w = __smoke.main(); return w && w !== m && w.isVisible() ? w : null }))`)
if (!second) fail('second-instance did not recreate the main window')

step('Settings › Shortcuts: validation, own-key conflict, save + off (INKFISH_SHORTCUTS=off: no OS registration)')
const sc = await main(`
  const fs = require('fs'), path = require('path') // command-line require is gone after the first await
  const w = __smoke.main()
  await __smoke.wait(() => !w.webContents.isLoading())
  const call = (id, acc) => w.webContents.executeJavaScript('window.api.shortcuts.set(' + JSON.stringify(id) + ',' + JSON.stringify(acc) + ')')
  const bare = await call('capture', 'Space')
  const set = await call('capture', 'Control+Alt+N')
  const clash = await call('daily', 'Alt+Control+N')
  const file = JSON.parse(fs.readFileSync(path.join(E.app.getPath('userData'), 'shortcuts.json'), 'utf8'))
  const off = await call('daily', '')
  return { bare: bare.error, set: set.error, capture: set.settings.capture, clash: clash.error, keptDaily: clash.settings.daily, file, offDaily: off.settings.daily, disabled: off.disabled }`)
if (!sc.bare || !/modifier|⌘|Ctrl/.test(sc.bare)) fail(`bare Space was not refused: ${JSON.stringify(sc)}`)
if (sc.set !== null || sc.capture !== 'Control+Alt+N') fail(`capture shortcut not saved: ${JSON.stringify(sc)}`)
if (!sc.clash || !sc.clash.includes('quick capture')) fail(`daily = capture keys not refused: ${JSON.stringify(sc)}`)
if (sc.keptDaily === 'Control+Alt+N') fail('refused change still replaced the daily shortcut')
if (sc.file.capture !== 'Control+Alt+N') fail(`shortcuts.json not written: ${JSON.stringify(sc.file)}`)
if (sc.offDaily !== '' || !sc.disabled) fail(`clearing daily / disabled flag wrong: ${JSON.stringify(sc)}`)

clearTimeout(timer)
console.log('WINDOW SMOKE OK')
await main(`setTimeout(() => E.app.exit(0), 50); return true`).catch(() => {})
await sleep(500)
child.kill('SIGKILL')
rmSync(userData, { recursive: true, force: true })
process.exit(0)
