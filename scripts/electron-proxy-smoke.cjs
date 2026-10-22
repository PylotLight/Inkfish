#!/usr/bin/env node
'use strict'

// End-to-end proxy smoke test. Run after `bun run build`:
//   xvfb-run -a node scripts/electron-proxy-smoke.cjs
// Uses an isolated Electron userData/vault and a local SOCKS5 mock only.
const { spawn, spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const net = require('node:net')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const main = path.join(root, 'out/main/index.js')
if (!existsSync(main)) throw new Error(`Build missing: ${main}; run bun run build first.`)
const temp = mkdtempSync(path.join(tmpdir(), 'inkfish-proxy-smoke-'))
const userData = path.join(temp, 'profile')
const vault = path.join(temp, 'vault')
const bridgeModule = path.join(temp, 'model-download-proxy.cjs')
const bundle = spawnSync(
  'bun',
  [
    'build',
    path.join(root, 'src/main/model-download-proxy.ts'),
    '--target=node',
    '--format=cjs',
    '--outfile',
    bridgeModule
  ],
  { encoding: 'utf8' }
)
assert.equal(bundle.status, 0, bundle.stderr)
mkdirSync(userData, { recursive: true })
mkdirSync(vault, { recursive: true })

const settings = {
  primary: { enabled: true, host: '127.0.0.1', port: 0, bypassLocalNetwork: false },
  proxies: [],
  rules: [],
  killSwitch: false
}
let child
let localServer
let stopping = false
let success = false
const socksDestinations = []
const fail = (e) => {
  if (!stopping) {
    console.error(e?.stack || e)
    if (child) child.kill('SIGTERM')
  }
}

// Child is the Electron main process. Set profile paths before importing the real entry point.
const runner = path.join(temp, 'runner.cjs')
require('node:fs').writeFileSync(
  runner,
  `
const { app, BrowserWindow, dialog, session } = require('electron');
const fs = require('node:fs');
app.setPath('userData', process.env.INKFISH_SMOKE_USERDATA);
const originalErrorBox = dialog.showErrorBox;
dialog.showErrorBox = (title, message) => { process.stderr.write('SMOKE_DIALOG_ERROR '+title+': '+message+'\\n'); app.quit(); };
process.on('uncaughtException', e => { process.stderr.write('SMOKE_FATAL '+(e.stack||e)+'\\n'); app.quit(); });
process.on('unhandledRejection', e => { process.stderr.write('SMOKE_FATAL '+(e?.stack||e)+'\\n'); app.quit(); });
require(process.env.INKFISH_SMOKE_MAIN);
let done = false;
const mark = (v) => { if(done)return; done=true; process.stdout.write('SMOKE_RESULT '+JSON.stringify(v)+'\\n'); setTimeout(()=>app.quit(),100); };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const until = async (fn, ms=15000) => { const end=Date.now()+ms; while(Date.now()<end){try{const v=await fn();if(v)return v}catch{} await wait(100)} throw Error('Timed out waiting for '+ms+'ms condition'); };
app.whenReady().then(async()=>{
 try {
   const win=await until(()=>BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL()&&!w.webContents.getURL().includes('#')));
   // Wait for app IPC registration/render and drive the actual Settings → Network UI when present.
   await until(async()=>{const u=await win.webContents.executeJavaScript('Boolean(window.api && window.api.proxy)');return u||false});
   if(process.env.INKFISH_SMOKE_MODE==='restore') { const restored=await win.webContents.executeJavaScript('window.api.proxy.get()'); mark({restored}); return; }
   await until(()=>win.webContents.executeJavaScript('Boolean(document.querySelector("button[aria-label=Settings]"))'));
   await win.webContents.executeJavaScript('document.querySelector("button[aria-label=Settings]").click()');
   await until(()=>win.webContents.executeJavaScript('Boolean(document.querySelector(".settings-nav"))'));
   await win.webContents.executeJavaScript('[...document.querySelectorAll(".settings-nav-item")].find(b=>b.textContent.includes("Network")).click()');
   await until(()=>win.webContents.executeJavaScript('Boolean(document.querySelector(".network-settings fieldset"))'));
   const networkVisible=await win.webContents.executeJavaScript('document.body.innerText.includes("SOCKS5 proxy")');
   await win.webContents.executeJavaScript('document.querySelector(".network-settings [role=switch]").click()');
   await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="Save proxy settings").click()');
   await until(()=>win.webContents.executeJavaScript('Boolean(document.querySelector(".network-settings-message")?.textContent.includes("saved"))'));
   await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(b=>b.textContent==="Test TCP port").click()');
   await until(()=>win.webContents.executeJavaScript('Boolean(document.querySelector(".network-settings-message")?.textContent.includes("reachable"))'));
   // Exercise the actual renderer bridge, backed by the application's registered IPC handlers.
   const initial=await win.webContents.executeJavaScript('window.api.proxy.get()');
   const invalid=await win.webContents.executeJavaScript('window.api.proxy.set('+JSON.stringify({...${JSON.stringify(settings)},primary:{...${JSON.stringify(settings.primary)},host:'8.8.8.8'}})+').then(()=>({rejected:false})).catch(e=>({rejected:true,message:e.message}))');
   if(!invalid.rejected) throw Error('Unsafe non-loopback proxy host was accepted');
   const oversized={...${JSON.stringify(settings)},primary:{...${JSON.stringify(settings.primary)},port:1080},proxies:Array.from({length:17},(_,i)=>({name:'P'+i,host:'127.0.0.1',port:1000+i}))};
   const overLimit=await win.webContents.executeJavaScript('window.api.proxy.set('+JSON.stringify(oversized)+').then(()=>false).catch(()=>true)');
   if(!overLimit) throw Error('Proxy list exceeding the supported maximum was accepted');
   const sockPort=Number(process.env.INKFISH_SMOKE_SOCKS_PORT);
   const configured={...${JSON.stringify(settings)},primary:{...${JSON.stringify(settings.primary)},port:sockPort}, proxies:[{name:'Alternate',host:'127.0.0.1',port:sockPort+1}],rules:[{pattern:'exact.invalid',route:'direct'},{pattern:'*.wild.invalid',route:'proxy:Alternate'}]};
   const saved=await win.webContents.executeJavaScript('window.api.proxy.set('+JSON.stringify(configured)+')');
   // Exercise the same bridge supplied to FluidAudio's http_proxy/https_proxy.
   const {createModelDownloadProxy}=require(process.env.INKFISH_SMOKE_BRIDGE);
   const bridge=await createModelDownloadProxy(saved,()=>false);
   let nativeDownload;
   try {
     nativeDownload=await new Promise((resolve,reject)=>{
       const req=require('node:http').get(bridge.url,{path:'http://native-model.invalid:18767/model.bin',headers:{Range:'bytes=3-'}},res=>{
         let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body}));res.on('error',reject);
       });req.on('error',reject);
     });
   } finally { bridge.close(); }
   if(nativeDownload.body!=='proxy-success') throw Error('Native model bridge did not use SOCKS');
   const resolver={exact:await session.defaultSession.resolveProxy('https://exact.invalid'),wildcard:await session.defaultSession.resolveProxy('https://sub.wild.invalid'),named:await session.defaultSession.resolveProxy('https://other.invalid')};
   const fetchResponse=await session.defaultSession.fetch('http://dns-check.invalid:18765/smoke');
   const fetchResult={status:fetchResponse.status,text:await fetchResponse.text()};
   const test=await win.webContents.executeJavaScript('window.api.proxy.test('+JSON.stringify(configured)+')');
   const deadPort=Number(process.env.INKFISH_SMOKE_DEAD_PORT);
   const kill={...configured,primary:{...configured.primary,port:deadPort},rules:[],killSwitch:true};
   await win.webContents.executeJavaScript('window.api.proxy.set('+JSON.stringify(kill)+')');
   const killFetch=await session.defaultSession.fetch('http://kill-check.invalid:18766/smoke').then(()=>({blocked:false}),e=>({blocked:true,error:String(e)}));
   mark({initial,saved,invalid,overLimit,networkVisible,nativeDownload,resolver,fetchResult,test,killFetch});
 } catch(e) { process.stderr.write('SMOKE_FAILURE '+(e.stack||e)+'\\n'); app.quit(); }
});
`
)

function socksMock() {
  let receivedHost = null
  localServer = net.createServer((socket) => {
    let buf = Buffer.alloc(0),
      state = 0
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      try {
        if (state === 0) {
          if (buf.length < 2) return
          const n = buf[1]
          if (buf.length < 2 + n) return
          buf = buf.subarray(2 + n)
          socket.write(Buffer.from([5, 0]))
          state = 1
        }
        if (state === 1) {
          if (buf.length < 5) return
          const atyp = buf[3]
          let len, off
          if (atyp === 3) {
            len = buf[4]
            off = 5
            if (buf.length < off + len + 2) return
            receivedHost = buf.subarray(off, off + len).toString()
            off += len
          } else if (atyp === 1) {
            if (buf.length < 10) return
            receivedHost = [...buf.subarray(4, 8)].join('.')
            off = 8
          } else {
            if (buf.length < 22) return
            receivedHost = buf.subarray(4, 20).toString('hex')
            off = 20
          }
          const port = buf.readUInt16BE(off)
          buf = buf.subarray(off + 2)
          state = 2
          const reply = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
          socket.write(reply)
          socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nproxy-success`)
          socket.end()
          socksDestinations.push(receivedHost)
          process.stdout.write('SMOKE_SOCKS ' + JSON.stringify({ host: receivedHost, port }) + '\n')
        }
      } catch (e) {
        socket.destroy()
      }
    })
  })
  return new Promise((resolve, reject) =>
    localServer.once('error', reject).listen(0, '127.0.0.1', () => resolve(localServer.address().port))
  )
}

;(async () => {
  try {
    const socksPort = await socksMock()
    const deadProbe = net.createServer()
    const deadPort = await new Promise((resolve, reject) =>
      deadProbe.once('error', reject).listen(0, '127.0.0.1', () => {
        const p = deadProbe.address().port
        deadProbe.close(() => resolve(p))
      })
    )
    child = spawn(require('electron'), [runner], {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        INKFISH_SMOKE_USERDATA: userData,
        INKFISH_VAULT: vault,
        INKFISH_SMOKE_MAIN: main,
        INKFISH_SMOKE_BRIDGE: bridgeModule,
        INKFISH_SMOKE_SOCKS_PORT: String(socksPort),
        INKFISH_SMOKE_DEAD_PORT: String(deadPort)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = '',
      err = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
      process.stdout.write(d)
      if (out.includes('SMOKE_RESULT ')) success = true
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
      process.stderr.write(d)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      stopping = true
      try {
        if (code !== 0 || !success) throw Error(`Electron smoke failed (exit ${code}).\n${err}`)
        const result = JSON.parse(out.match(/SMOKE_RESULT (.+)/)[1])
        assert.equal(result.networkVisible, true)
        assert.equal(result.nativeDownload.body, 'proxy-success')
        assert.ok(socksDestinations.includes('native-model.invalid'))
        assert.equal(result.invalid.rejected, true)
        assert.equal(result.fetchResult.text, 'proxy-success')
        assert.match(result.resolver.exact, /DIRECT/)
        assert.match(result.resolver.wildcard, /SOCKS5 127\.0\.0\.1:/)
        assert.doesNotMatch(result.resolver.wildcard, /DIRECT/)
        assert.match(result.resolver.named, /SOCKS5 127\.0\.0\.1:/)
        assert.equal(result.test.reachable, true)
        assert.equal(result.overLimit, true)
        assert.equal(result.killFetch.blocked, true)
        const persisted = JSON.parse(readFileSync(path.join(userData, 'proxy.json'), 'utf8'))
        assert.equal(persisted.primary.port, deadPort)
        assert.equal(persisted.killSwitch, true)
        const probeEnv = {
          ...process.env,
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
          INKFISH_SMOKE_USERDATA: userData,
          INKFISH_VAULT: vault,
          INKFISH_SMOKE_MAIN: main,
          INKFISH_SMOKE_MODE: 'restore'
        }
        const restart = spawnSync(require('electron'), [runner], {
          cwd: root,
          env: probeEnv,
          encoding: 'utf8',
          timeout: 20000
        })
        assert.equal(restart.status, 0, restart.stderr)
        const restored = JSON.parse(restart.stdout.match(/SMOKE_RESULT (.+)/)[1]).restored
        assert.deepEqual(restored, persisted, 'fresh launch restores saved routing before windows load')
        require('node:fs').writeFileSync(path.join(userData, 'proxy.json'), '{broken json')
        const corrupt = spawnSync(require('electron'), [runner], {
          cwd: root,
          env: probeEnv,
          encoding: 'utf8',
          timeout: 20000
        })
        assert.match(corrupt.stderr, /SMOKE_DIALOG_ERROR Inkfish could not start safely: Saved SOCKS settings/)
        assert.doesNotMatch(corrupt.stdout, /SMOKE_RESULT/)
        assert.equal(corrupt.signal, null, 'corrupt saved settings exit without hanging')
        console.log(
          'PASS: Network UI Save/Test, native model SOCKS download bridge, proxy IPC, unsafe input rejection, SOCKS remote DNS, kill switch, fresh-launch restore and corrupt-config refusal; no external network used.'
        )
      } catch (e) {
        console.error(e.stack || e)
        process.exitCode = 1
      }
      localServer?.close()
      rmSync(temp, { recursive: true, force: true })
    })
  } catch (e) {
    stopping = true
    localServer?.close()
    rmSync(temp, { recursive: true, force: true })
    throw e
  }
})().catch(fail)
