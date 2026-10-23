import { BENCH_MODES, corpusWer, speedFactor, wordErrorRate, type BenchMode } from '../src/shared/sttBench'
import { WEB_ENGINES, prepareWeb, resetWeb, transcribeWeb } from '../src/renderer/src/webStt'

const urls = import.meta.glob('../src/renderer/src/assets/bench/*.{wav,flac}', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

async function limited<T>(work: Promise<T>, ms: number, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          resetWeb(id)
          reject(new Error(`${id} exceeded ${Math.round(ms / 1000)} s`))
        }, ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

Object.assign(window, {
  inkfishBench: {
    engines: WEB_ENGINES.map(({ id, name }) => ({ id, name })),
    async run(id: string, mode: BenchMode) {
      const engine = WEB_ENGINES.find((e) => e.id === id)
      if (!engine) throw new Error(`Unknown web engine ${id}`)
      const clips = await Promise.all(
        BENCH_MODES[mode].clips.map(async (clip) => {
          const url = urls[`../src/renderer/src/assets/bench/${clip.file}`]
          if (!url) throw new Error(`Missing fixture ${clip.file}`)
          return { clip, audio: await (await fetch(url)).blob() }
        })
      )
      const cold = performance.now()
      let lastProgress = 0
      await limited(
        prepareWeb(id, (p) => {
          if (performance.now() - lastProgress < 5000) return
          lastProgress = performance.now()
          console.log(
            `[bench] ${id}: ${p.phase} ${Math.round(p.loaded / 1e6)} MB${p.total ? ` / ${Math.round(p.total / 1e6)} MB` : ''}`
          )
        }),
        600_000,
        id
      )
      const loadMs = Math.round(performance.now() - cold)
      console.log(`[bench] ${id}: ${mode} warming up`)
      await limited(transcribeWeb(id, clips[0]!.audio), 600_000, id)
      const warmMs = Math.round(performance.now() - cold)
      const rows = []
      for (const { clip, audio } of clips) {
        console.log(`[bench] ${id}: ${mode} ${clip.id}`)
        const result = await limited(transcribeWeb(id, audio), Math.round(60_000 + clip.seconds * 2000), id)
        rows.push({
          id: clip.id,
          seconds: clip.seconds,
          source: clip.source,
          ...wordErrorRate(clip.text, result.text),
          ms: result.ms ?? 0,
          runtime: result.runtime,
          text: result.text
        })
      }
      const decodeMs = rows.reduce((sum, row) => sum + row.ms, 0)
      const seconds = rows.reduce((sum, row) => sum + row.seconds, 0)
      return {
        id,
        name: engine.name,
        mode,
        wer: corpusWer(rows),
        speed: speedFactor(seconds, decodeMs),
        loadMs,
        warmMs,
        decodeMs,
        clips: rows
      }
    },
    reset: resetWeb
  }
})
