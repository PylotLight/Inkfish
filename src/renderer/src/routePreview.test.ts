import { describe, expect, test } from 'bun:test'
import { appendHint, KEEP_IN_INBOX, type RoutePreview } from '../../shared/routing'
import { captureKind, createPreviewer, previewable, previewKey, previewOptions, previewRouteKey } from './routePreview'

const P = (over: Partial<RoutePreview> = {}): RoutePreview => ({
  action: 'new',
  folder: 'Garden',
  target: null,
  tags: [],
  confidence: 0.72,
  reason: 'Garden: 2 related notes (72%)',
  override: false,
  suggested: false,
  aiMayRefine: false,
  alt: { folder: null, append: { rel: 'Garden/Tomato log.md', title: 'Tomato log' } },
  candidates: [],
  ...over
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('route preview helpers', () => {
  test('kind matches the save rule', () => {
    expect(captureKind([])).toBe('text')
    expect(captureKind(['assets/a.png'])).toBe('image')
    expect(captureKind(['assets/a.png', 'assets/v.wav'])).toBe('voice')
  })

  test('hidden for empty / very short / image-only text', () => {
    expect(previewable('')).toBe(false)
    expect(previewable('hi')).toBe(false)
    expect(previewable('![](assets/x.png)')).toBe(false)
    expect(previewable('tomato staking')).toBe(true)
  })

  test('route key of a preview', () => {
    expect(previewRouteKey(P())).toBe('new:Garden')
    const append = P({ action: 'append', target: { rel: 'Garden/Tomato log.md', title: 'Tomato log' } })
    expect(previewRouteKey(append)).toBe('append:Garden/Tomato log.md')
    expect(previewRouteKey(P({ action: 'inbox', folder: '' }))).toBe('review:')
  })

  test('menu: switch append↔new, other folder, keep in inbox', () => {
    const projects = [{ id: 'garden', dir: 'Garden' }]
    const ids = (o: ReturnType<typeof previewOptions>): string[] => o.map((x) => x.id)
    const n = previewOptions(P(), 'auto', projects)
    expect(ids(n)).toEqual(['append', 'folder', 'inbox'])
    expect(n[0]?.hint).toBe(appendHint('Garden/Tomato log.md'))
    const appended = P({
      action: 'append',
      target: { rel: 'Garden/Tomato log.md', title: 'Tomato log' },
      alt: { folder: 'Garden', append: null }
    })
    const a = previewOptions(appended, 'auto', projects)
    expect(ids(a)).toEqual(['new', 'folder', 'inbox'])
    expect(a[0]?.hint).toBe('garden')
    const keptP = P({ action: 'inbox', override: true, alt: { folder: 'Garden', append: null } })
    expect(ids(previewOptions(keptP, KEEP_IN_INBOX, projects))).toEqual(['auto', 'new', 'folder'])
  })

  test('menu: related-note candidates join as add-to options, deduped against the line', () => {
    const projects = [{ id: 'garden', dir: 'Garden' }]
    const cands = [
      { rel: 'Garden/Tomato log.md', title: 'Tomato log', score: 0.8 },
      { rel: 'Garden/Basil.md', title: 'Basil', score: 0.5 },
      { rel: 'Garden/Mint.md', title: 'Mint', score: 0.3 }
    ]
    const n = previewOptions(P({ candidates: cands }), 'auto', projects)
    expect(n.map((x) => x.id)).toEqual(['append', 'cand:Garden/Basil.md', 'cand:Garden/Mint.md', 'folder', 'inbox'])
    expect(n[1]?.hint).toBe(appendHint('Garden/Basil.md'))
    const appended = P({
      action: 'append',
      target: { rel: 'Garden/Tomato log.md', title: 'Tomato log' },
      alt: { folder: 'Garden', append: null },
      candidates: cands
    })
    const a = previewOptions(appended, 'auto', projects)
    expect(a.map((x) => x.id)).toEqual(['cand:Garden/Basil.md', 'cand:Garden/Mint.md', 'new', 'folder', 'inbox'])
  })
})

describe('createPreviewer', () => {
  test('debounces typing into one fetch for the last text', async () => {
    const calls: string[] = []
    const got: string[] = []
    const pv = createPreviewer(
      async (a) => {
        calls.push(a.raw)
        return P({ reason: a.raw })
      },
      (_k, p) => got.push(p?.reason ?? 'null'),
      20
    )
    pv.request({ raw: 'tom', kind: 'text', hint: 'auto' })
    pv.request({ raw: 'tomato', kind: 'text', hint: 'auto' })
    pv.request({ raw: 'tomato staking', kind: 'text', hint: 'auto' })
    await sleep(80)
    expect(calls).toEqual(['tomato staking'])
    expect(got).toEqual(['tomato staking'])
  })

  test('drops a stale in-flight answer once newer text is requested', async () => {
    const got: string[] = []
    const pv = createPreviewer(
      async (a) => {
        await sleep(a.raw === 'slow old text' ? 60 : 5)
        return P({ reason: a.raw })
      },
      (k, p) => got.push(`${p?.reason}|${k === previewKey(p?.reason ?? '', 'text', 'auto')}`),
      5
    )
    pv.request({ raw: 'slow old text', kind: 'text', hint: 'auto' })
    await sleep(20) // the old text's fetch is now in flight
    pv.request({ raw: 'new text', kind: 'text', hint: 'auto' })
    await sleep(120)
    expect(got).toEqual(['new text|true'])
  })

  test('cancel drops everything pending', async () => {
    const got: unknown[] = []
    const pv = createPreviewer(
      async () => P(),
      (_k, p) => got.push(p),
      10
    )
    pv.request({ raw: 'tomato staking', kind: 'text', hint: 'auto' })
    pv.cancel()
    await sleep(40)
    expect(got).toEqual([])
  })
})
