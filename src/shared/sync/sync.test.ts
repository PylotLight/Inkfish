import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { conflictPath, mergeDaily, mergeNote, mergeText, neededFromRemote, plan, resolveMerge, sha256 } from './index'
import type { Manifest } from './index'

const e = (hash: string): { hash: string; size: number; mtime: number } => ({ hash, size: 1, mtime: 0 })

describe('sha256', () => {
  test('matches node crypto', () => {
    for (const s of ['', 'abc', 'é ünïcode 🐙', 'x'.repeat(1000), 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)])
      expect(sha256(s)).toBe(createHash('sha256').update(s).digest('hex'))
  })
})

describe('diff3', () => {
  const base = 'a\nb\nc\nd\ne'
  test('non-overlapping edits merge', () => {
    const r = mergeText(base, 'A\nb\nc\nd\ne', 'a\nb\nc\nd\nE')
    expect(r).toEqual({ clean: true, text: 'A\nb\nc\nd\nE', conflicts: 0 })
  })
  test('same edit both sides', () => {
    expect(mergeText(base, 'a\nB\nc\nd\ne', 'a\nB\nc\nd\ne').text).toBe('a\nB\nc\nd\ne')
  })
  test('overlapping edits conflict, keep ours', () => {
    const r = mergeText(base, 'a\nX\nc\nd\ne', 'a\nY\nc\nd\ne')
    expect(r.clean).toBe(false)
    expect(r.text).toBe('a\nX\nc\nd\ne')
  })
  test('both append at end keeps both', () => {
    const r = mergeText(base, `${base}\nours`, `${base}\ntheirs`)
    expect(r).toEqual({ clean: true, text: `${base}\nours\ntheirs`, conflicts: 0 })
  })
  test('delete on one side, edit elsewhere on other', () => {
    expect(mergeText(base, 'a\nc\nd\ne', 'a\nb\nc\nd\nE').text).toBe('a\nc\nd\nE')
  })
})

describe('notes', () => {
  const fm = (tags: string[], status = 'ready'): string => `---\nid: n1\nstatus: ${status}\ntags:\n${tags.map((t) => `  - ${t}`).join('\n')}\n---\n`
  test('frontmatter per key + list union + body merge', () => {
    const base = `${fm(['a'])}# T\n\none\nmid\ntwo\n`
    const ours = `${fm(['a', 'b'])}# T\n\nONE\nmid\ntwo\n`
    const theirs = `${fm(['a', 'c'], 'archived')}# T\n\none\nmid\nTWO\n`
    const r = mergeNote(base, ours, theirs)
    expect(r.clean).toBe(true)
    expect(r.text).toBe(`---\nid: n1\nstatus: archived\ntags:\n  - a\n  - b\n  - c\n---\n# T\n\nONE\nmid\nTWO\n`)
  })
  test('adjacent-line edits are a conflict (like git)', () => {
    expect(mergeNote('x\ny\n', 'X\ny\n', 'x\nY\n').clean).toBe(false)
  })
  test('daily union, deduped, time-sorted', () => {
    const head = '---\nkind: daily\n---\n# 2026-10-08\n\n'
    const ours = `${head}## 09:10\n\ncoffee\n\n## 13:00\n\nlunch\n`
    const theirs = `${head}## 09:10\n\ncoffee\n\n## 11:30\n\nstandup\n`
    expect(mergeDaily(ours, theirs)).toBe(`${head}## 09:10\n\ncoffee\n\n## 11:30\n\nstandup\n\n## 13:00\n\nlunch\n`)
  })
  test('conflict path', () => {
    expect(conflictPath('work/Idea.md', 'Pixel 8', new Date(2026, 9, 8, 9, 4))).toBe('work/Idea (conflict · Pixel 8 · 2026-10-08 0904).md')
  })
})

describe('plan', () => {
  test('pull, push, deletes, edit beats delete, merge, move', () => {
    const base = { 'a.md': 'A', 'b.md': 'B', 'c.md': 'C', 'd.md': 'D', 'e.md': 'E', 'f.md': 'F', 'old.md': 'M' }
    const local: Manifest = { 'a.md': e('A2'), 'b.md': e('B'), 'd.md': e('D'), 'e.md': e('E3'), 'f.md': e('F4'), 'old.md': e('M') }
    const remote: Manifest = { 'a.md': e('A'), 'b.md': e('B2'), 'c.md': e('C'), 'e.md': e('E2'), 'f.md': e('F5'), 'new/old.md': e('M'), '.inkfish/x': e('Z') }
    // a: local edit → push; b: remote edit → pull; c: local deleted → deleteRemote; d: remote deleted → deleteLocal
    // e: both edited → merge; f: both edited → merge; old.md moved remotely → moveLocal
    expect(plan(local, remote, base)).toEqual([
      { op: 'push', path: 'a.md', hash: 'A2' },
      { op: 'pull', path: 'b.md', hash: 'B2' },
      { op: 'deleteRemote', path: 'c.md' },
      { op: 'deleteLocal', path: 'd.md' },
      { op: 'merge', path: 'e.md', kind: 'note', local: 'E3', remote: 'E2', base: 'E' },
      { op: 'merge', path: 'f.md', kind: 'note', local: 'F4', remote: 'F5', base: 'F' },
      { op: 'moveLocal', from: 'old.md', to: 'new/old.md' }
    ])
  })
  test('edit wins over delete', () => {
    expect(plan({}, { 'x.md': e('X2') }, { 'x.md': 'X' })).toEqual([{ op: 'pull', path: 'x.md', hash: 'X2' }])
  })
  test('needed hashes skip content already held locally', () => {
    const ops = plan({ 'a.png': e('H') }, { 'a.png': e('H'), 'copy.png': e('H'), 'n.md': e('N') }, {})
    expect(neededFromRemote(ops, { 'a.png': e('H') })).toEqual(['N'])
  })
  test('binary conflict keeps both', () => {
    const w = resolveMerge({ op: 'merge', path: 'assets/x.png', kind: 'binary', local: '1', remote: '2' }, { local: '', remote: '' }, 'Mac', new Date(2026, 9, 8, 1, 2))
    expect(w).toEqual([
      { path: 'assets/x.png', from: 'local' },
      { path: 'assets/x (conflict · Mac · 2026-10-08 0102).png', from: 'remote' }
    ])
  })
})
