// Benchmark every native speech engine on the bundled LibriSpeech clip.
//
//   bun run bench:stt              # engines already downloaded
//   bun run bench:stt --download   # download missing models first (several GB)
//   bun run bench:stt --runs 3     # median of N runs per engine
//
// Prints accuracy (word error rate) and speed (× real time) per engine and
// writes bench-results.json. Needs the helper: `bun run stt:build`.
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BENCH_CLIP, fmtSpeed, fmtWer, speedFactor, wordErrorRate } from '../src/shared/sttBench'

const root = join(import.meta.dir, '..')
const bin = join(root, 'stt', 'bin', 'inkfish-stt')
const clip = join(root, 'src', 'renderer', 'src', 'assets', 'bench', BENCH_CLIP.file)
const download = process.argv.includes('--download')
const runsArg = process.argv.indexOf('--runs')
const runs = Math.max(1, runsArg > -1 ? Number(process.argv[runsArg + 1]) || 1 : 1)

if (!existsSync(bin)) {
  console.error('[bench] helper not built — run `bun run stt:build` first')
  process.exit(1)
}

type Engine = { id: string; name: string; ready: boolean; available: boolean; downloadable?: boolean }
const helper = (args: string[], timeout = 600_000): string =>
  execFileSync(bin, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })

let engines = JSON.parse(helper(['engines'])) as Engine[]
if (download) {
  for (const e of engines.filter((x) => x.available && !x.ready && x.downloadable)) {
    console.log(`[bench] downloading ${e.name}…`)
    try {
      helper(['prepare', '--engine', e.id], 60 * 60_000)
    } catch (err) {
      console.warn(`[bench] ${e.name}: download failed — ${(err as Error).message.split('\n')[0]}`)
    }
  }
  engines = JSON.parse(helper(['engines'])) as Engine[]
}

const ready = engines.filter((e) => e.ready)
const skipped = engines.filter((e) => !e.ready).map((e) => e.name)
console.log(`[bench] ${BENCH_CLIP.seconds} s clip, ${ready.length} engines, ${runs} run(s) each\n`)

type Row = { id: string; name: string; wer?: number; speed?: number; ms?: number; error?: string; text?: string }
const rows: Row[] = []
for (const e of ready) {
  const times: number[] = []
  let text = ''
  try {
    // Warm-up run loads the model into the Neural Engine; not timed.
    helper(['transcribe', clip, '--engine', e.id])
    for (let i = 0; i < runs; i++) {
      const t0 = Date.now()
      const out = JSON.parse(helper(['transcribe', clip, '--engine', e.id])) as { text?: string; ms?: number }
      times.push(out.ms ?? Date.now() - t0)
      text = out.text ?? ''
    }
    const ms = times.sort((a, b) => a - b)[Math.floor(times.length / 2)] as number
    const row = { id: e.id, name: e.name, ms, text, wer: wordErrorRate(BENCH_CLIP.text, text).wer, speed: speedFactor(BENCH_CLIP.seconds, ms) }
    rows.push(row)
    console.log(`  ${e.name.padEnd(32)} ${fmtWer(row.wer).padStart(6)} errors  ${fmtSpeed(row.speed)}`)
  } catch (err) {
    const error = (err as { stderr?: string }).stderr?.trim().split('\n').pop() || (err as Error).message
    rows.push({ id: e.id, name: e.name, error })
    console.log(`  ${e.name.padEnd(32)} failed: ${error}`)
  }
}

const ok = rows.filter((r) => r.wer !== undefined).sort((a, b) => (a.wer as number) - (b.wer as number))
console.log('\n| Engine | Errors (WER) | Speed |\n| --- | --- | --- |')
for (const r of ok) console.log(`| ${r.name} | ${fmtWer(r.wer as number)} | ${fmtSpeed(r.speed as number)} |`)
if (skipped.length) console.log(`\nNot downloaded: ${skipped.join(', ')} (use --download)`)

writeFileSync(join(root, 'bench-results.json'), JSON.stringify({ at: new Date().toISOString(), clip: BENCH_CLIP.source, rows }, null, 2))
console.log('\n[bench] wrote bench-results.json')
