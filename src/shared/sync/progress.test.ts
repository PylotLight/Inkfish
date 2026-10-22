import { describe, expect, test } from 'bun:test'
import { runSync, type SyncProgress } from './engine'
import { markDone, progressPoster, supportsProgress, hello } from './client'
import {
  cleanProgress,
  cleanRun,
  etaMs,
  percent,
  progressLine,
  progressShort,
  pushRun,
  runFromReport,
  runLine,
  RUNS_CAP,
  type LiveProgress,
  type PeerRun
} from './progress'
import { createHandler } from './server'
import { CiFs, MemFs, MemState, random } from './testkit'
import { httpRemote, type Fetch, type MacPeer } from './client'
import { PEER_HEADER } from './protocol'
import { toBase64 } from './bytes'
import { deriveSyncBadge, emptyActivity, badgeChanged } from '../sync-badge'

const P = (x: Partial<SyncProgress>): SyncProgress => ({
  stage: 'downloading',
  done: 0,
  total: 0,
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: 0,
  stageAt: 0,
  ...x
})

describe('progress display helpers', () => {
  test('percent / eta / lines', () => {
    expect(percent(P({ done: 1, total: 4 }))).toBe(25)
    expect(percent(P({ done: 1, total: 4, bytesDone: 50, bytesTotal: 100 }))).toBe(50)
    expect(percent(P({}))).toBeNull()
    expect(etaMs(P({ bytesDone: 25, bytesTotal: 100, stageAt: 0 }), 4000)).toBe(12000)
    expect(etaMs(P({ bytesDone: 25, bytesTotal: 100, stageAt: 0 }), 1000)).toBeNull() // too early to guess
    expect(progressLine(P({ done: 30, total: 120, bytesDone: 3 << 20, bytesTotal: 12 << 20 }), 4000)).toBe(
      'downloading 30 of 120 · 3.0 MB of 12 MB · ~12s left'
    )
    expect(progressShort(P({ stage: 'comparing' }))).toBe('comparing')
    expect(progressShort(P({ done: 9, total: 10 }))).toBe('90%')
  })

  test('run lines + cap', () => {
    const r: PeerRun = { at: 1, ms: 4200, pulled: 12, pushed: 3, merged: 0, moved: 2, deleted: 0, conflicts: 1 }
    expect(runLine(r)).toBe('↓12 ↑3 · 2 moved · 1 conflict · 4.2s')
    expect(runLine({ ...r, pulled: 0, pushed: 0, moved: 0, conflicts: 0, ms: 300 })).toBe('nothing to do · 0.3s')
    expect(runLine({ ...r, error: 'offline' })).toBe('failed: offline')
    let runs: PeerRun[] = []
    for (let i = 0; i < RUNS_CAP + 3; i++) runs = pushRun(runs, { ...r, at: i })
    expect(runs).toHaveLength(RUNS_CAP)
    expect(runs[0]!.at).toBe(3)
  })

  test('wire values are sanitized and re-based on the Mac clock', () => {
    expect(cleanProgress({ stage: 'nope' }, 1)).toBeNull()
    expect(cleanProgress(null, 1)).toBeNull()
    // Phone clock 1h ahead: durations survive, absolute times move to ours.
    const lp = cleanProgress(
      {
        stage: 'uploading',
        done: 2,
        total: 4,
        bytesDone: -5,
        startedAt: 3_600_000 + 1000,
        stageAt: 3_600_000 + 3000,
        sentAt: 3_600_000 + 5000,
        current: 'x'.repeat(999)
      },
      10_000
    )!
    expect(lp.startedAt).toBe(6000)
    expect(lp.stageAt).toBe(8000)
    expect(lp.bytesDone).toBe(0)
    expect(lp.current!.length).toBe(300)
    expect(cleanRun({ pulled: 3, ms: 'x', error: 'e'.repeat(500) }, 5)).toEqual({
      at: 5,
      ms: 0,
      pulled: 3,
      pushed: 0,
      merged: 0,
      moved: 0,
      deleted: 0,
      conflicts: 0,
      error: 'e'.repeat(200)
    })
  })
})

describe('engine progress events', () => {
  test('throttled, stage-ordered, ends with done; counts match the transfer', async () => {
    const init: Record<string, string> = {}
    for (let i = 0; i < 300; i++) init[`Work/n${i}.md`] = `# ${i}\n`
    const mac = new CiFs(init)
    const phone = new MemFs({ 'Work/mine.md': 'm\n' })
    const events: SyncProgress[] = []
    const { remote } = wiredWithHooks(mac)
    let t = 0
    const r = await runSync({
      fs: phone,
      remote,
      state: new MemState(),
      remoteName: 'Mac',
      onProgress: (p) => events.push(p),
      clock: () => t++
    })
    expect(r.pulled).toBe(300)
    const stages = events.map((e) => e.stage).filter((s, i, a) => a[i - 1] !== s)
    expect(stages).toEqual(['comparing', 'downloading', 'applying', 'uploading', 'done'])
    // Far fewer events than files (the fake clock ticks 1ms per call, throttle is 250ms).
    expect(events.length).toBeLessThan(60)
    const lastDl = [...events].reverse().find((e) => e.stage === 'downloading')!
    expect(lastDl.total).toBe(300)
    expect(r.ms).toBeGreaterThan(0)
  })
})

describe('progress over the wire', () => {
  test('hello advertises it; posts are throttled; done carries the summary; old Macs are skipped', async () => {
    const mac = new CiFs({ 'a.md': 'a\n' })
    const got: LiveProgress[] = []
    const runs: PeerRun[] = []
    const w = wiredWithHooks(mac, { progress: (_id, p) => got.push(p), finished: (_id, r) => runs.push(r) })
    const h = await hello(w.fetchFn, '127.0.0.1', 1)
    expect(supportsProgress(h)).toBe(true)
    expect(supportsProgress({ app: 'inkfish', v: 1, id: 'x', name: 'old' })).toBe(false)

    const poster = progressPoster(w.fetchFn, '127.0.0.1', w.peer, 'phone-abcdef12', random, 50)
    for (let i = 0; i < 100; i++) poster.post(P({ done: i, total: 100 }))
    await poster.flush()
    expect(got.length).toBeLessThanOrEqual(3)
    expect(got[got.length - 1]!.done).toBe(99) // newest wins, last one always lands

    const report = await runSync({ fs: new MemFs(), remote: w.remote, state: new MemState(), remoteName: 'Mac' })
    await markDone(w.fetchFn, '127.0.0.1', w.peer, 'phone-abcdef12', random, runFromReport(report, 1000, 1234))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ pulled: 1, ms: 1234 })
    // Older phone: plain done still works.
    await markDone(w.fetchFn, '127.0.0.1', w.peer, 'phone-abcdef12', random)
    expect(runs).toHaveLength(1)
  })

  test('a Mac without /v1/progress (404) makes the poster go quiet, sync unaffected', async () => {
    const mac = new CiFs({ 'a.md': 'a\n' })
    const w = wiredWithHooks(mac)
    let calls = 0
    const fetch404: Fetch = async (url, init) => {
      if (url.endsWith('/v1/progress')) {
        calls++
        return { ok: false, status: 404, text: async () => 'not found' }
      }
      return w.fetchFn(url, init)
    }
    const poster = progressPoster(fetch404, '127.0.0.1', w.peer, 'phone-abcdef12', random, 1)
    poster.post(P({ done: 1, total: 2 }))
    await poster.flush()
    poster.post(P({ done: 2, total: 2 }))
    await poster.flush()
    expect(calls).toBe(1)
  })
})

describe('desktop badge with progress', () => {
  test('syncing row carries progress, label shows %, runs + device info pass through', () => {
    const now = 100_000
    const a = {
      ...emptyActivity(),
      lastSeen: now - 100,
      inFlight: 1,
      sessionSince: now - 2000,
      ip: '192.168.1.40',
      protocol: 1,
      progress: { ...P({ done: 5, total: 10 }), at: now }
    }
    const runs: PeerRun[] = [
      { at: now - 60_000, ms: 900, pulled: 1, pushed: 0, merged: 0, moved: 0, deleted: 0, conflicts: 0 }
    ]
    const b = deriveSyncBadge(
      { running: true, error: null, peers: [{ id: 'p', name: 'Pixel', lastSync: now - 60_000, activity: a, runs }] },
      now
    )
    expect(b.state).toBe('syncing')
    expect(b.label).toBe('Syncing with Pixel… 50%')
    expect(b.peers[0]!.progress?.done).toBe(5)
    expect(b.peers[0]!.ip).toBe('192.168.1.40')
    expect(b.peers[0]!.runs).toHaveLength(1)
    // A progress step is a repaint; an identical one isn't.
    const b2 = deriveSyncBadge(
      {
        running: true,
        error: null,
        peers: [
          {
            id: 'p',
            name: 'Pixel',
            lastSync: now - 60_000,
            activity: { ...a, progress: { ...a.progress, done: 6 } },
            runs
          }
        ]
      },
      now
    )
    expect(badgeChanged(b, b2)).toBe(true)
    expect(badgeChanged(b, b)).toBe(false)
    // Not syncing → no progress shown even if a stale one is around.
    const idle = deriveSyncBadge(
      {
        running: true,
        error: null,
        peers: [
          { id: 'p', name: 'Pixel', lastSync: now - 1000, activity: { ...a, inFlight: 0, sessionSince: null }, runs }
        ]
      },
      now
    )
    expect(idle.peers[0]!.progress).toBeNull()
  })
})

function wiredWithHooks(
  mac: CiFs,
  hooks: { progress?: (id: string, p: LiveProgress) => void; finished?: (id: string, r: PeerRun) => void } = {}
): { remote: ReturnType<typeof httpRemote>; fetchFn: Fetch; peer: MacPeer } {
  const key = random(32)
  const peerId = 'phone-abcdef12'
  const handle = createHandler({
    device: { id: 'mac-1234567890', name: 'Mac' },
    fs: mac,
    random,
    getPeer: async (id) => (id === peerId ? { id, name: 'Pixel', key: toBase64(key), pairedAt: 0 } : null),
    pending: () => null,
    addPeer: async () => undefined,
    touchPeer: () => undefined,
    changed: () => undefined,
    ...hooks
  })
  const fetchFn: Fetch = async (url, init) => {
    const u = new URL(url)
    const r = await handle(init?.method ?? 'GET', u.pathname, init?.headers?.[PEER_HEADER] ?? null, init?.body ?? '')
    return { ok: r.status === 200, status: r.status, text: async () => r.body }
  }
  const peer: MacPeer = { id: 'mac-1234567890', name: 'Mac', key: toBase64(key), hosts: ['127.0.0.1'], port: 1 }
  return { remote: httpRemote(fetchFn, '127.0.0.1', peer, peerId, random), fetchFn, peer }
}
