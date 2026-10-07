// Benchmark every native speech engine on the bundled clips.
//
//   bun run bench:stt              # Quick: one 79 s clip of clean read English
//   bun run bench:stt --deep       # Deep: Australian earnings calls + hard read speech, per clip
//   bun run bench:stt --download   # download missing models first (several GB)
//   bun run bench:stt --runs 3     # median of N runs per clip
//
// Prints accuracy (word error rate, with wrong/missed/extra words), decode
// speed (× real time, model load excluded), warm-up and load time, and size
// per engine, and writes bench-results.json. Needs the helper: `bun run stt:build`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BENCH_MODES,
  corpusWer,
  fmtMsShort,
  fmtSpeed,
  fmtWer,
  speedFactor,
  wordErrorRate,
  type BenchMode
} from '../src/shared/sttBench'
import { parseHelperJson } from '../src/shared/stt'

const root = join(import.meta.dir, '..')
const bin = join(root, 'stt', 'bin', 'inkfish-stt')
const mode: BenchMode = process.argv.includes('--deep') ? 'deep' : 'quick'
const clips = BENCH_MODES[mode].clips
const tmp = mkdtempSync(join(tmpdir(), 'inkfish-bench-'))
/** FLAC clips → 16 kHz wav with macOS afconvert (falls back to the file itself). */
const clipPath = (file: string): string => {
  const src = join(root, 'src', 'renderer', 'src', 'assets', 'bench', file)
  if (file.endsWith('.wav')) return src
  const out = join(tmp, file.replace(/\.\w+$/, '.wav'))
  try {
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', src, out], { stdio: 'ignore' })
    return out
  } catch {
    return src
  }
}
const paths = clips.map((c) => clipPath(c.file))
const download = process.argv.includes('--download')
const runsArg = process.argv.indexOf('--runs')
const runs = Math.max(1, runsArg > -1 ? Number(process.argv[runsArg + 1]) || 1 : 1)

if (!existsSync(bin)) {
  console.error('[bench] helper not built — run `bun run stt:build` first')
  process.exit(1)
}

type Engine = {
  id: string
  name: string
  ready: boolean
  available: boolean
  downloadable?: boolean
  bytes?: number
  size?: string
}
const helper = (args: string[], timeout = 600_000): string =>
  execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })

let engines = parseHelperJson<Engine[]>(helper(['engines'])) ?? []
if (download) {
  for (const e of engines.filter((x) => x.available && !x.ready && x.downloadable)) {
    console.log(`[bench] downloading ${e.name}…`)
    try {
      helper(['prepare', '--engine', e.id], 60 * 60_000)
    } catch (err) {
      console.warn(`[bench] ${e.name}: download failed — ${(err as Error).message.split('\n')[0]}`)
    }
  }
  engines = parseHelperJson<Engine[]>(helper(['engines'])) ?? []
}

const ready = engines.filter((e) => e.ready)
const skipped = engines.filter((e) => !e.ready).map((e) => e.name)
const total = clips.reduce((a, c) => a + c.seconds, 0)
console.log(
  `[bench] ${mode}: ${clips.length} clip(s), ${Math.round(total)} s of audio, ${ready.length} engines, ${runs} run(s) each\n`
)

type Out = { text?: string; ms?: number; loadMs?: number; runtime?: string }
type ClipRow = {
  id: string
  wer: number
  errors: number
  words: number
  subs: number
  dels: number
  ins: number
  ms: number
  loadMs: number
  text: string
}
type Row = {
  id: string
  name: string
  bytes?: number
  wer?: number
  speed?: number
  warmMs?: number
  loadMs?: number
  clips?: ClipRow[]
  runtime?: string
  error?: string
}
const rows: Row[] = []
const size = (e: Engine): string => (e.bytes ? `${Math.round(e.bytes / 1e6)} MB` : (e.size ?? '?'))
for (const e of ready) {
  try {
    // Cold run: first load can compile for the Neural Engine. Timed as warm-up.
    const w0 = Date.now()
    helper(['transcribe', paths[0]!, '--engine', e.id])
    const warmMs = Date.now() - w0
    const per: ClipRow[] = []
    let runtime = ''
    for (const [k, c] of clips.entries()) {
      const outs: Out[] = []
      for (let i = 0; i < runs; i++) {
        const t0 = Date.now()
        const o = parseHelperJson<Out>(helper(['transcribe', paths[k]!, '--engine', e.id])) ?? {}
        outs.push({ ...o, ms: o.ms ?? Date.now() - t0 })
      }
      const o = outs.sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))[Math.floor(outs.length / 2)]!
      runtime ||= o.runtime ?? ''
      const w = wordErrorRate(c.text, o.text ?? '')
      per.push({ id: c.id, ...w, ms: o.ms ?? 0, loadMs: o.loadMs ?? 0, text: o.text ?? '' })
    }
    const decodeMs = per.reduce((a, p) => a + Math.max(1, p.ms - p.loadMs), 0)
    const row: Row = {
      id: e.id,
      name: e.name,
      bytes: e.bytes,
      wer: corpusWer(per),
      speed: speedFactor(total, decodeMs),
      warmMs,
      loadMs: Math.round(per.reduce((a, p) => a + p.loadMs, 0) / per.length),
      clips: per,
      runtime
    }
    rows.push(row)
    const s = per.reduce((a, p) => a + p.subs, 0)
    const d = per.reduce((a, p) => a + p.dels, 0)
    const ins = per.reduce((a, p) => a + p.ins, 0)
    console.log(
      `  ${e.name.padEnd(30)} ${fmtWer(row.wer!).padStart(6)} errors (${s} wrong, ${d} missed, ${ins} extra)  ${fmtSpeed(row.speed!)}  warm-up ${fmtMsShort(warmMs)}  load ${fmtMsShort(row.loadMs!)}  ${size(e)}`
    )
    if (clips.length > 1) {
      console.log(
        `  ${''.padEnd(30)} ${per.map((p) => `${clips.find((c) => c.id === p.id)!.label} ${fmtWer(p.wer)}`).join(' · ')}`
      )
    }
  } catch (err) {
    const error = (err as { stderr?: string }).stderr?.trim().split('\n').pop() || (err as Error).message
    rows.push({ id: e.id, name: e.name, error })
    console.log(`  ${e.name.padEnd(30)} failed: ${error}`)
  }
}

const ok = rows.filter((r) => r.wer !== undefined).sort((a, b) => (a.wer as number) - (b.wer as number))
const clipCols = clips.length > 1 ? clips.map((c) => c.label) : []
console.log(
  `\n| Engine | Errors (WER) | ${clipCols.map((c) => `${c} | `).join('')}Speed | Warm-up | Load | Size |\n|${' --- |'.repeat(7 + clipCols.length)}`
)
for (const r of ok) {
  const per = clipCols.length ? r.clips!.map((p) => `${fmtWer(p.wer)} | `).join('') : ''
  const e = engines.find((x) => x.id === r.id)!
  console.log(
    `| ${r.name} | ${fmtWer(r.wer as number)} | ${per}${fmtSpeed(r.speed as number)} | ${fmtMsShort(r.warmMs ?? 0)} | ${fmtMsShort(r.loadMs ?? 0)} | ${size(e)} |`
  )
}
if (skipped.length) console.log(`\nNot downloaded: ${skipped.join(', ')} (use --download)`)

writeFileSync(
  join(root, 'bench-results.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      mode,
      clips: clips.map((c) => ({ id: c.id, seconds: c.seconds, source: c.source })),
      rows
    },
    null,
    2
  )
)
console.log('\n[bench] wrote bench-results.json')
