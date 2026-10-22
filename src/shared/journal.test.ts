import { describe, expect, test } from 'bun:test'
import {
  dailyRefs,
  entryCountLabel,
  filterDays,
  groupByMonth,
  heatLevel,
  isDailyPath,
  matchesDay,
  monthCounts,
  monthGrid,
  monthLabel,
  plainLine,
  shiftMonth,
  stepDay,
  streak,
  summarizeDay,
  withoutDaily
} from './journal'

const row = (path: string, extra: Partial<{ size: number; snippet: string; updatedAt: number }> = {}) => ({
  id: path,
  path,
  updatedAt: extra.updatedAt ?? 0,
  size: extra.size ?? 100,
  snippet: extra.snippet ?? ''
})

const NOW = new Date(2026, 9, 20, 9, 0)

describe('dailyRefs / withoutDaily', () => {
  test('picks daily notes only, newest day first, regardless of mtime', () => {
    const refs = dailyRefs([
      row('daily/2026-10-18.md', { updatedAt: 999 }),
      row('work/2026-10-19-plan.md'),
      row('daily/2026-10-20.md', { updatedAt: 1 }),
      row('daily/notes.md'),
      row('daily/2026-02-30.md'), // not a real date
      row('daily/2025-12-31.md')
    ])
    expect(refs.map((r) => r.day)).toEqual(['2026-10-20', '2026-10-18', '2025-12-31'])
    expect(refs[0]!.path).toBe('daily/2026-10-20.md')
  })

  test('recent list drops dailies but keeps other notes in daily-ish folders', () => {
    const notes = [row('daily/2026-10-20.md'), row('work/a.md'), row('journal/2026-10-20.md'), row('daily/readme.md')]
    expect(withoutDaily(notes).map((n) => n.path)).toEqual(['work/a.md', 'journal/2026-10-20.md', 'daily/readme.md'])
    expect(isDailyPath('daily/2026-10-20.md')).toBe(true)
    expect(isDailyPath('daily/2026-10-20.md.bak')).toBe(false)
  })

  test('handles a few hundred days quickly and in order', () => {
    const notes = Array.from({ length: 2000 }, (_, i) => row(`work/n${i}.md`))
    for (let i = 0; i < 400; i++) {
      const d = new Date(2025, 0, 1 + i)
      notes.push(
        row(
          `daily/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`
        )
      )
    }
    const t = performance.now()
    const refs = dailyRefs(notes)
    const rows = groupByMonth(refs)
    expect(performance.now() - t).toBeLessThan(100)
    expect(refs).toHaveLength(400)
    expect(rows.filter((r) => r.kind === 'month')).toHaveLength(14)
    expect(refs[0]!.day > refs[399]!.day).toBe(true)
  })
})

describe('summarizeDay', () => {
  test('counts entries and keeps the first few, morning first, markup stripped', () => {
    const body = [
      '- 09:10 coffee with **sam**',
      '- 10:00 · voice · standup [[Project X|px]] notes',
      '  second line',
      '- 11:30 lunch',
      '- 15:45 shipped _it_'
    ].join('\n')
    const s = summarizeDay(body, 2)
    expect(s.count).toBe(4)
    expect(s.entries).toEqual([
      { time: '09:10', text: 'coffee with sam' },
      { time: '10:00', text: 'standup px notes', kind: 'voice' }
    ])
    expect(s.text).toBe('')
  })

  test('reads legacy ## HH:MM sections and drops the old # date title', () => {
    const s = summarizeDay('# 2026-10-01\n\n## 08:00\n\nwoke up\n\n## 21:15 · voice\n\nbed', 5)
    expect(s.count).toBe(2)
    expect(s.entries.map((e) => e.text)).toEqual(['woke up', 'bed'])
  })

  test('free text without entries becomes a snippet; empty stays empty', () => {
    expect(summarizeDay('# heading\n\njust some *thoughts*\n- a list item\n')).toEqual({
      count: 0,
      entries: [],
      text: 'heading · just some thoughts · a list item'
    })
    expect(summarizeDay('')).toEqual({ count: 0, entries: [], text: '' })
  })

  test('plainLine drops images, links and emphasis', () => {
    expect(plainLine('![x](a.png) see [docs](http://x) and `code` ~~old~~')).toBe('see docs and code old')
    expect(plainLine('- [ ] task')).toBe('task')
  })
})

describe('months', () => {
  test('labels and shifting across years', () => {
    expect(monthLabel('2026-10')).toBe('October 2026')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-10', -14)).toBe('2025-08')
  })

  test('groupByMonth inserts a header whenever the month changes, with per-month counts', () => {
    const days = ['2026-10-20', '2026-10-02', '2026-09-30', '2025-10-20'].map((day) => ({ day, id: day }))
    const rows = groupByMonth(days)
    expect(rows.map((r) => (r.kind === 'month' ? `# ${r.label} (${r.count})` : r.day))).toEqual([
      '# October 2026 (2)',
      '2026-10-20',
      '2026-10-02',
      '# September 2026 (1)',
      '2026-09-30',
      '# October 2025 (1)',
      '2025-10-20'
    ])
  })

  test('monthCounts newest first', () => {
    expect(monthCounts(['2026-09-01', '2026-10-01', '2026-10-05'])).toEqual([
      { key: '2026-10', label: 'October 2026', count: 2 },
      { key: '2026-09', label: 'September 2026', count: 1 }
    ])
  })

  test('monthGrid is Monday-first weeks of 7 with padding', () => {
    const g = monthGrid('2026-10') // 1 Oct 2026 is a Thursday
    expect(g.every((w) => w.length === 7)).toBe(true)
    expect(g[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(g.flat().filter(Boolean)).toHaveLength(31)
    expect(g[g.length - 1]!.includes('2026-10-31')).toBe(true)
    // Feb 2027 starts on a Monday
    expect(monthGrid('2027-02')[0]![0]).toBe('2027-02-01')
    expect(monthGrid('nope')).toEqual([])
  })
})

describe('filtering', () => {
  const items = [
    { day: '2026-10-20', id: 'a', text: 'coffee with sam' },
    { day: '2026-10-19', id: 'b', text: 'gym, then groceries' },
    { day: '2026-09-03', id: 'c', text: '' },
    { day: '2025-10-01', id: 'd', text: 'Sam birthday' }
  ]
  const textOf = (i: (typeof items)[number]): string => i.text

  test('matches text, ISO date, friendly title and month names; all words must hit', () => {
    expect(filterDays(items, 'sam', textOf, undefined, NOW).map((i) => i.id)).toEqual(['a', 'd'])
    expect(filterDays(items, 'september', textOf, undefined, NOW).map((i) => i.id)).toEqual(['c'])
    expect(filterDays(items, '2025', textOf, undefined, NOW).map((i) => i.id)).toEqual(['d'])
    expect(filterDays(items, 'mon 19 oct', textOf, undefined, NOW).map((i) => i.id)).toEqual(['b'])
    expect(filterDays(items, 'sam october 2026', textOf, undefined, NOW).map((i) => i.id)).toEqual(['a'])
    expect(filterDays(items, '  ', textOf, undefined, NOW)).toHaveLength(4)
  })

  test('full-text hits (unread bodies) are added in', () => {
    expect(filterDays(items, 'dentist', textOf, new Set(['c']), NOW).map((i) => i.id)).toEqual(['c'])
  })

  test('matchesDay is case-insensitive', () => {
    expect(matchesDay('2026-10-20', 'COFFEE', 'Coffee time', NOW)).toBe(true)
    expect(matchesDay('2026-10-20', 'tea', 'Coffee time', NOW)).toBe(false)
  })
})

describe('streak / heat / stepping', () => {
  test('streak counts back from today, or from yesterday when today has no note yet', () => {
    expect(streak(['2026-10-20', '2026-10-19', '2026-10-18', '2026-10-16'], '2026-10-20')).toBe(3)
    expect(streak(['2026-10-19', '2026-10-18'], '2026-10-20')).toBe(2)
    expect(streak(['2026-10-17'], '2026-10-20')).toBe(0)
    // across a month boundary
    expect(streak(['2026-11-01', '2026-10-31', '2026-10-30'], '2026-11-01')).toBe(3)
  })

  test('heat buckets by size; front-matter-only notes are empty', () => {
    expect(heatLevel(undefined)).toBe(0)
    expect(heatLevel(70)).toBe(0)
    expect(heatLevel(200)).toBe(1)
    expect(heatLevel(1000)).toBe(2)
    expect(heatLevel(9000)).toBe(3)
  })

  test('stepDay clamps at the ends and starts from the first item', () => {
    const days = ['2026-10-20', '2026-10-19', '2026-10-15']
    expect(stepDay(days, null, 1)).toBe('2026-10-20')
    expect(stepDay(days, null, -1)).toBe('2026-10-15')
    expect(stepDay(days, '2026-10-20', 1)).toBe('2026-10-19')
    expect(stepDay(days, '2026-10-15', 1)).toBe('2026-10-15')
    expect(stepDay(days, '2026-10-20', -1)).toBe('2026-10-20')
    expect(stepDay(days, 'gone', 1)).toBe('2026-10-20')
    expect(stepDay([], null, 1)).toBeNull()
  })

  test('entry count label', () => {
    expect(entryCountLabel(1)).toBe('1 entry')
    expect(entryCountLabel(0)).toBe('0 entries')
  })
})
