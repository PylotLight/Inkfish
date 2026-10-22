import { describe, expect, test } from 'bun:test'
import {
  appendEntry,
  appendToDailyFile,
  dailyTitle,
  dailyTitleForPath,
  dayOfPath,
  formatEntry,
  isLegacyBoilerplate,
  migrateLegacyDaily,
  parseEntries,
  shiftDay,
  splitDailyFile,
  stripLegacyTitle
} from './daily'
import { mergeDaily } from './sync'

const now = new Date(2026, 9, 20, 0, 37)

describe('daily titles + paths', () => {
  test('friendly title, year only when not this year', () => {
    expect(dailyTitle('2026-10-20', now)).toBe('Tue 20 Oct')
    expect(dailyTitle('2026-01-01', now)).toBe('Thu 1 Jan')
    expect(dailyTitle('2025-11-03', now)).toBe('Mon 3 Nov 2025')
    expect(dailyTitle('not-a-day', now)).toBe('not-a-day')
  })
  test('only real daily/YYYY-MM-DD.md paths count', () => {
    expect(dayOfPath('daily/2026-10-20.md')).toBe('2026-10-20')
    expect(dailyTitleForPath('daily/2026-10-20.md', now)).toBe('Tue 20 Oct')
    expect(dayOfPath('daily/2026-02-30.md')).toBeNull()
    expect(dayOfPath('work/2026-10-20.md')).toBeNull()
    expect(dailyTitleForPath('inbox/x.md', now)).toBeNull()
  })
  test('shiftDay crosses months/years', () => {
    expect(shiftDay('2026-10-20', -1)).toBe('2026-10-19')
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('daily entries', () => {
  test('formatEntry: compact time prefix, kind tag, indented continuation', () => {
    expect(formatEntry('coffee', 'text', now)).toBe('- 00:37 coffee')
    expect(formatEntry('  hi  ', undefined, new Date(2026, 9, 20, 9, 5))).toBe('- 09:05 hi')
    expect(formatEntry('standup\n\nshipped x', 'voice', now)).toBe('- 00:37 · voice · standup\n\n  shipped x')
    expect(formatEntry('![](assets/a.png)', 'image', now)).toBe('- 00:37 · image · ![](assets/a.png)')
  })
  test('appendEntry: empty → entry; after entry → tight; after prose → blank line', () => {
    expect(appendEntry('', '- 00:37 a')).toBe('- 00:37 a\n')
    expect(appendEntry('\n\n', '- 00:37 a')).toBe('- 00:37 a\n')
    expect(appendEntry('- 00:37 a\n\n', '- 01:00 b')).toBe('- 00:37 a\n- 01:00 b\n')
    expect(appendEntry('- 00:37 a\n  more\n', '- 01:00 b')).toBe('- 00:37 a\n  more\n- 01:00 b\n')
    expect(appendEntry('some notes', '- 01:00 b')).toBe('some notes\n\n- 01:00 b\n')
    expect(appendEntry('## 09:00\n\nold entry\n', '- 10:00 b')).toBe('## 09:00\n\nold entry\n\n- 10:00 b\n')
  })
  test('appendToDailyFile keeps front matter verbatim', () => {
    const fm = '---\nkind: daily\nsource: tray\n---\n'
    expect(appendToDailyFile(fm, '- 00:37 a')).toBe(`${fm}- 00:37 a\n`)
    expect(appendToDailyFile(`${fm}- 00:37 a\n`, '- 00:40 b')).toBe(`${fm}- 00:37 a\n- 00:40 b\n`)
    expect(splitDailyFile('no fm')).toEqual({ fm: '', body: 'no fm' })
  })
  test('parseEntries reads new bullets and old ## sections', () => {
    const body =
      '# 2026-10-20\n\n## 08:00 · voice\n\nold one\n\nnotes\n\n- 09:10 coffee\n- 9:30 · image · ![](a.png)\n- 10:00\n  later line\n'
    expect(parseEntries(body)).toEqual([
      { time: '08:00', text: 'old one', kind: 'voice' },
      { time: '09:10', text: 'coffee' },
      { time: '09:30', text: '![](a.png)', kind: 'image' },
      { time: '10:00', text: 'later line' }
    ])
    expect(parseEntries('just prose\n- not a time')).toEqual([])
  })
})

describe('legacy cleanup', () => {
  const fm = '---\nkind: daily\ncreated: 2026-10-19T13:37:00.000Z\nsource: tray\n---\n'
  test('only the exact old generated body counts', () => {
    expect(isLegacyBoilerplate('# 2026-10-20\n\n## 00:37\n\n_Day started._\n\n', '2026-10-20')).toBe(true)
    expect(isLegacyBoilerplate('# 2026-10-20\n\n## 00:37\n\n_Day started._', '2026-10-20')).toBe(true)
    expect(isLegacyBoilerplate('# 2026-10-21\n\n## 00:37\n\n_Day started._\n', '2026-10-20')).toBe(false)
    expect(isLegacyBoilerplate('# 2026-10-20\n\n## 00:37\n\n_Day started._\nme\n', '2026-10-20')).toBe(false)
    expect(isLegacyBoilerplate('# 2026-10-20\n\n## 00:37\n\nDay started.\n', '2026-10-20')).toBe(false)
  })
  test('migrateLegacyDaily → front matter only, or null to leave it', () => {
    expect(migrateLegacyDaily(`${fm}# 2026-10-20\n\n## 00:37\n\n_Day started._\n\n`, '2026-10-20')).toBe(fm)
    expect(
      migrateLegacyDaily(`${fm}# 2026-10-20\n\n## 00:37\n\n_Day started._\n\n## 01:00\n\nx\n`, '2026-10-20')
    ).toBeNull()
  })
  test('stripLegacyTitle drops only a leading ISO-date H1', () => {
    expect(stripLegacyTitle('# 2026-10-20\n\n- 09:00 a\n')).toBe('- 09:00 a\n')
    expect(stripLegacyTitle('# Plans\n\nx')).toBe('# Plans\n\nx')
    expect(stripLegacyTitle('- 09:00 a')).toBe('- 09:00 a')
  })
})

describe('daily sync merge (new format)', () => {
  const head = '---\nkind: daily\n---\n'
  test('bullet union, deduped, time-sorted, one tight list', () => {
    const ours = `${head}- 09:10 coffee\n- 13:00 lunch\n`
    const theirs = `${head}- 09:10 coffee\n- 11:30 standup\n  with notes\n`
    expect(mergeDaily(ours, theirs)).toBe(`${head}- 09:10 coffee\n- 11:30 standup\n  with notes\n- 13:00 lunch\n`)
  })
  test('free text above entries keeps ours; empty notes stay empty', () => {
    const ours = `${head}plan for today\n\n- 09:10 coffee\n`
    const theirs = `${head}- 08:00 run\n`
    expect(mergeDaily(ours, theirs)).toBe(`${head}plan for today\n\n- 08:00 run\n- 09:10 coffee\n`)
    expect(mergeDaily(head, head)).toBe(head)
  })
  test('old ## sections and new bullets merge together', () => {
    const ours = `${head}# 2026-10-08\n\n## 09:10\n\ncoffee\n`
    const theirs = `${head}- 10:00 standup\n`
    expect(mergeDaily(ours, theirs)).toBe(`${head}# 2026-10-08\n\n## 09:10\n\ncoffee\n\n- 10:00 standup\n`)
  })
})
