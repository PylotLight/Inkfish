import { app, BrowserWindow, utilityProcess, session } from 'electron'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Electron smoke for the native AI integration (Electron 45 local AI handler):
// forks the BUILT out/main/ai-handler.js, registers it with session.registerLocalAIHandler, points it
// at a fake OpenAI-compatible server on loopback, and drives the renderer's Prompt API.
//   bun run build && bun run test:electron-ai      (headless Linux: add --ozone-platform=headless)
const HANDLER = process.env.HANDLER || join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'main', 'ai-handler.js')
const DIR = mkdtempSync(join(tmpdir(), 'inkfish-ai-smoke-'))
const seen = []
const srv = http.createServer((req, res) => {
  let b = ''
  req.on('data', (d) => (b += d))
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '# Tidy' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' note' } }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
const timer = setTimeout(() => {
  console.log('SMOKE TIMEOUT')
  app.exit(2)
}, 40000)
app.whenReady().then(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const child = utilityProcess.fork(HANDLER, [], { serviceName: 'Inkfish AI', stdio: 'inherit' })
  child.postMessage({
    type: 'config',
    config: {
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'm',
        apiKey: 'sk-smoke',
        // Settings › AI › Models: 'v' is a vision model with limits + a reasoning level.
        models: [{ id: 'm' }, { id: 'v', contextWindow: 32000, maxOutputTokens: 4000, reasoning: 'low', input: ['text', 'image'] }]
      }
    })
  session.defaultSession.registerLocalAIHandler(child)
  const w = new BrowserWindow({ show: false, webPreferences: { enableBlinkFeatures: 'AIPromptAPI' } })
  writeFileSync(join(DIR, 'blank.html'), '<html><body>x</body></html>')
  await w.loadFile(join(DIR, 'blank.html'))
  const results = {}
  try {
    results.availability = await w.webContents.executeJavaScript('LanguageModel.availability()')
    results.prompt = await w.webContents.executeJavaScript(
      `LanguageModel.create({initialPrompts:[{role:'system',content:'sys'}]}).then(m => m.prompt('hello'))`
    )
    results.streaming = await w.webContents.executeJavaScript(
      `LanguageModel.create().then(async m => { const r = m.promptStreaming('hi').getReader(); let o=''; for(;;){const {done,value}=await r.read(); if(done) return o; o+=value} })`
    )
    // Per-run model tag + an image part (what NoteAi sends for a vision model with Include images on).
    results.vision = await w.webContents.executeJavaScript(`(async () => {
      const c = new OffscreenCanvas(4, 4); const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 4, 4)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const url = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob) })
      const m = await LanguageModel.create({ initialPrompts: [{ role: 'system', content: '[[inkfish-run {"model":"v"}]]\\nsys2' }] })
      return m.prompt('look\\n[[inkfish-image ' + url + ']]')
    })()`)
    // Origin gate: an opaque data: page must not get a session.
    const d = new BrowserWindow({ show: false, webPreferences: { enableBlinkFeatures: 'AIPromptAPI' } })
    await d.loadURL('data:text/html,<p>x</p>')
    results.dataOrigin = await d.webContents.executeJavaScript(
      `typeof LanguageModel === 'undefined' ? 'rejected' : LanguageModel.create().then(()=> 'created', () => 'rejected')`
    )
    d.destroy()
    session.defaultSession.registerLocalAIHandler(null)
    results.afterOff = await w.webContents.executeJavaScript(
      `LanguageModel.create().then(()=> 'created', e => 'rejected: ' + e.message)`
    )
  } catch (e) {
    results.error = String(e)
  }
  results.server = seen.map((s) => ({
    url: s.url,
    auth: s.auth,
    model: s.body.model,
    max_tokens: s.body.max_tokens,
    reasoning_effort: s.body.reasoning_effort,
    messages: s.body.messages.map((m) => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map((p) => (p.type === 'image_url' ? `image_url:${p.image_url.url.slice(0, 22)}…` : p.text)) : m.content
    }))
  }))
  const v = results.server.find((s) => s.model === 'v')
  console.log('SMOKE', JSON.stringify(results))
  const ok =
    results.availability === 'available' &&
    results.prompt === '# Tidy note' &&
    results.streaming === '# Tidy note' &&
    results.dataOrigin === 'rejected' &&
    String(results.afterOff).startsWith('rejected') &&
    results.server[0]?.auth === 'Bearer sk-smoke' &&
    results.server[0]?.messages[0]?.role === 'system' &&
    results.vision === '# Tidy note' &&
    v?.messages[0]?.content === 'sys2' &&
    v?.reasoning_effort === 'low' &&
    v?.max_tokens > 0 &&
    v?.max_tokens <= 4000 &&
    Array.isArray(v?.messages[1]?.content) &&
    String(v.messages[1].content[1]).startsWith('image_url:data:image/png')
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL')
  clearTimeout(timer)
  child.kill()
  app.exit(ok ? 0 : 1)
})
