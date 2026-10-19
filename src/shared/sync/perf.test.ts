import { describe, expect, test } from 'bun:test'
import { runBench } from '../../../scripts/bench-sync'

/**
 * Perf guardrails on the sync benchmark (scripts/bench-sync.ts) with all
 * simulated latency off, so it's deterministic: count the phone-side
 * bridge calls and requests per scenario instead of timing them.
 */
describe('sync perf budget', () => {
  test('idle sync: one stat per entry, no reads, no hashing, one request', async () => {
    const res = await runBench({ notes: 400, images: 12, legacy: false, scale: 0 })
    const [initial, idle, small, again] = res
    // Initial: pulls stream in a handful of batches; nothing is re-read or re-hashed afterwards.
    expect(initial!.pulled).toBe(412)
    expect(initial!.counters.requests['/v1/get']!).toBeLessThanOrEqual(6)
    expect(initial!.counters.read).toBe(0)
    expect(initial!.counters.hash).toBe(0)

    const entries = 412 + 6 /* folders */ + 1 /* assets */ + 1 /* assets/2026 */ + 12 /* months */
    for (const r of [idle!, again!]) {
      expect(r.pulled + r.pushed).toBe(0)
      expect(r.counters.stat).toBeLessThanOrEqual(entries + 4)
      expect(r.counters.read).toBe(0)
      expect(r.counters.hash).toBe(0)
      expect(r.counters.textGet).toBe(0) // was one base-text read per note per sync
      expect(r.counters.requests).toEqual({ '/v1/manifest': 1 })
    }

    // Small change: only the three phone-edited notes are hashed / read.
    expect(small!.pulled).toBe(7)
    expect(small!.pushed).toBe(3)
    expect(small!.counters.hash).toBe(3)
    expect(small!.counters.read).toBe(3)
    expect(small!.counters.requests).toEqual({ '/v1/manifest': 1, '/v1/get': 1, '/v1/apply': 1 })
  })

  test('the legacy walk really was the slow part (sanity check on the harness)', async () => {
    const res = await runBench({ notes: 100, images: 4, legacy: true, scale: 0 })
    expect(res[1]!.counters.stat).toBeGreaterThanOrEqual(3 * 104) // heal pass + two stats per file
  })
})
