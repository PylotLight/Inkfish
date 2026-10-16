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
    const body = JSON.parse(b)
    seen.push({ url: req.url, auth: req.headers.authorization, body })
    // 'luna' is responses-only (like openai.gpt-6-luna behind LiteLLM); 'broken' always fails.
    if (body.model === 'broken') {
      res.writeHead(418, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'teapot says no to sk-smoke', type: 'invalid_request_error', code: 'teapot' } }))
      return
    }
    if (req.url.endsWith('/chat/completions') && body.model === 'luna') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'This model is only supported in v1/responses and not in v1/chat/completions.', type: 'invalid_request_error', code: 'unsupported_api_for_model' } }))
      return
    }
    if (req.url.endsWith('/responses')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const ev = (type, extra = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`)
      ev('response.created', { response: { id: 'r1' } })
      ev('response.output_text.delta', { delta: '# Luna' })
      ev('response.output_text.delta', { delta: ' note' })
      ev('response.completed', { response: { status: 'completed' } })
      res.end()
      return
    }
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
  const fromHandler = []
  child.on('message', (m) => fromHandler.push(m))
  child.postMessage({
    type: 'config',
    config: {
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'm',
        apiKey: 'sk-smoke',
        // Settings › AI › Models: 'v' is a vision model with limits + a reasoning level.
        models: [
          { id: 'm' },
          { id: 'v', contextWindow: 32000, maxOutputTokens: 4000, reasoning: 'low', input: ['text', 'image'] },
          { id: 'luna', reasoning: 'medium' },
          { id: 'broken' }
        ]
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
    // Auto API: chat/completions says responses-only → the handler retries on /responses.
    results.luna = await w.webContents.executeJavaScript(
      `LanguageModel.create({initialPrompts:[{role:'system',content:'[[inkfish-run {"model":"luna","errors":"inline"}]]\\nsys3'}]}).then(m => m.prompt('hi'))`
    )
    // A failing request with errors:inline → the real error arrives as a sentinel chunk.
    results.inlineError = await w.webContents.executeJavaScript(
      `LanguageModel.create({initialPrompts:[{role:'system',content:'[[inkfish-run {"model":"broken","errors":"inline"}]]\\nsys'}]}).then(m => m.prompt('hi'))`
    )
    // Without the flag: what Electron itself passes through (the user's bug).
    results.plainError = await w.webContents.executeJavaScript(
      `LanguageModel.create({initialPrompts:[{role:'system',content:'[[inkfish-run {"model":"broken"}]]\\nsys'}]}).then(m => m.prompt('hi')).then(r => 'ok:' + r, e => e.name + ': ' + e.message)`
    )
    await new Promise((r) => setTimeout(r, 200))
    results.fromHandler = fromHandler.map((m) => (m.type === 'error' ? { type: m.type, status: m.detail?.status, endpoint: m.detail?.endpoint } : m))
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
    reasoning: s.body.reasoning,
    instructions: s.body.instructions,
    input: s.body.input,
    messages: (s.body.messages ?? []).map((m) => ({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map((p) => (p.type === 'image_url' ? `image_url:${p.image_url.url.slice(0, 22)}…` : p.text)) : m.content
    }))
  }))
  const v = results.server.find((s) => s.model === 'v')
  const lunaCalls = results.server.filter((s) => s.model === 'luna')
  const sentinel = /\u2063\[\[inkfish-error (\{[\s\S]*\})\]\]$/.exec(String(results.inlineError))
  const inline = sentinel ? JSON.parse(sentinel[1]) : null
  results.inline = inline
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
    String(v.messages[1].content[1]).startsWith('image_url:data:image/png') &&
    results.luna === '# Luna note' &&
    lunaCalls.map((s) => s.url).join(',') === '/v1/chat/completions,/v1/responses' &&
    lunaCalls[1]?.instructions === 'sys3' &&
    lunaCalls[1]?.reasoning?.effort === 'medium' &&
    lunaCalls[1]?.input?.[0]?.content?.[0]?.type === 'input_text' &&
    results.fromHandler.some((m) => m.type === 'learned' && m.model === 'luna' && m.endpoint === 'responses') &&
    inline?.status === 418 &&
    inline?.endpoint === 'POST /chat/completions' &&
    inline?.model === 'broken' &&
    String(inline?.message).includes('teapot says no') &&
    !String(results.inlineError).includes('sk-smoke') &&
    /kErrorUnknown|unknown error/i.test(String(results.plainError)) &&
    results.fromHandler.some((m) => m.type === 'error' && m.status === 418)
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL')
  clearTimeout(timer)
  child.kill()
  app.exit(ok ? 0 : 1)
})
