import { describe, expect, test } from 'bun:test'
import { stageTimingLine, SyncStageTimer } from '../src/lib/synctimings'

describe('phone sync stage timings', () => {
  test('accumulates finding and engine stages and excludes the done marker', () => {
    let now = 0
    const timer = new SyncStageTimer(() => now)
    timer.enter('finding')
    now = 125
    timer.enter('comparing')
    now = 375
    timer.enter('downloading')
    now = 1375
    timer.enter('done')
    now = 1500

    const timings = timer.finish()
    expect(timings).toEqual({ finding: 125, comparing: 250, downloading: 1000 })
    expect(stageTimingLine(timings)).toBe('Find 0.1s · Compare 0.3s · Download 1s')
    expect(timer.finish()).toEqual(timings)
  })

  test('repeated stage events do not reset a stage and absent stages stay hidden', () => {
    let now = 10
    const timer = new SyncStageTimer(() => now)
    timer.enter('applying')
    now = 80
    timer.enter('applying')
    now = 130
    expect(stageTimingLine(timer.finish())).toBe('Apply 0.1s')
    expect(stageTimingLine(undefined)).toBeNull()
    expect(stageTimingLine({})).toBeNull()
  })
})
