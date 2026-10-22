import { describe, expect, test } from 'bun:test'
import {
  RecoveryBudget,
  LogThrottle,
  STABILITY_RECENT_LIMIT,
  countStabilityEvent,
  createShutdown,
  emptyStabilityCounters,
  errorSignature,
  stabilityFailureTotal
} from './stability'

describe('stability counters', () => {
  test('count, keep a bounded recent list, and total only failures', () => {
    const c = emptyStabilityCounters()
    for (let i = 0; i < STABILITY_RECENT_LIMIT + 5; i++) countStabilityEvent(c, 'rendererGone', `crash ${i}`, 0)
    countStabilityEvent(c, 'rendererReloads', null)
    countStabilityEvent(c, 'unresponsive', 'hung')
    expect(c.rendererGone).toBe(STABILITY_RECENT_LIMIT + 5)
    expect(c.recent.length).toBe(STABILITY_RECENT_LIMIT)
    expect(c.recent.at(-1)).toContain('unresponsive: hung')
    expect(stabilityFailureTotal(c)).toBe(STABILITY_RECENT_LIMIT + 5)
  })
})

describe('LogThrottle', () => {
  test('logs the head, then every Nth', () => {
    const t = new LogThrottle(2, 10)
    const logged = Array.from({ length: 25 }, () => t.shouldLog('x')).filter(Boolean)
    expect(logged).toEqual([1, 2, 10, 20])
  })
  test('forgets the oldest signature past the cap', () => {
    const t = new LogThrottle(1, 100, 2)
    t.shouldLog('a')
    t.shouldLog('b')
    t.shouldLog('c')
    expect(t.shouldLog('a')).toBe(1)
  })
})

describe('RecoveryBudget', () => {
  test('allows limit attempts per window', () => {
    const b = new RecoveryBudget(3, 1000)
    expect([b.tryTake(0), b.tryTake(1), b.tryTake(2), b.tryTake(3)]).toEqual([true, true, true, false])
    expect(b.tryTake(1001)).toBe(true)
  })
})

describe('errorSignature', () => {
  test('first line of an error or value', () => {
    expect(errorSignature(new TypeError('bad\nstack'))).toBe('TypeError: bad')
    expect(errorSignature('plain\nmore')).toBe('plain')
  })
})

describe('createShutdown', () => {
  test('runs steps in order, survives a throwing step, runs once', () => {
    const order: string[] = []
    const logs: string[] = []
    const shutdown = createShutdown(
      [
        { name: 'watch', run: () => void order.push('watch') },
        {
          name: 'sync',
          run: () => {
            throw new Error('boom')
          }
        },
        { name: 'db', run: () => void order.push('db') }
      ],
      (m) => logs.push(m)
    )
    const results = shutdown()
    expect(order).toEqual(['watch', 'db'])
    expect(results.map((r) => r.ok)).toEqual([true, false, true])
    expect(logs[0]).toContain('sync failed: Error: boom')
    expect(shutdown()).toEqual([])
    expect(order).toEqual(['watch', 'db'])
  })
})
