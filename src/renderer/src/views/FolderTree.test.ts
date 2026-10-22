import { describe, expect, test } from 'bun:test'
import type { NoteEntry } from '../../../shared/types'
import { allDirRels, buildTree, parseTreeSort } from './FolderTree'

const note = (path: string, updatedAt: number): NoteEntry => ({
  id: path,
  path,
  title: path.split('/').pop()!.replace(/\.md$/, ''),
  kind: 'text',
  status: 'ready',
  projectId: null,
  inboxId: null,
  tags: [],
  snippet: '',
  createdAt: 0,
  updatedAt,
  size: 0
})
const titleOf = (n: NoteEntry): string => n.title

const notes = [
  note('Work/b.md', 10),
  note('Work/a.md', 30),
  note('Work/deep/x.md', 5),
  note('personal/z.md', 50),
  note('root-b.md', 1),
  note('root-a.md', 99)
]

describe('buildTree sort', () => {
  test('name: folders and files A→Z', () => {
    const t = buildTree(notes, titleOf)
    expect(t.roots.map((r) => r.name)).toEqual(['personal', 'Work'])
    expect(t.roots[1]!.files.map((f) => f.title)).toEqual(['a', 'b'])
    expect(t.rootFiles.map((f) => f.title)).toEqual(['root-a', 'root-b'])
    expect(t.roots[1]!.total).toBe(3)
  })
  test('modified: newest first, folders by newest note in subtree', () => {
    const t = buildTree(notes, titleOf, 'modified')
    expect(t.roots.map((r) => r.name)).toEqual(['personal', 'Work'])
    expect(t.roots[1]!.files.map((f) => f.title)).toEqual(['a', 'b'])
    expect(t.rootFiles.map((f) => f.title)).toEqual(['root-a', 'root-b'])
    const t2 = buildTree([...notes, note('Work/new.md', 100)], titleOf, 'modified')
    expect(t2.roots[0]!.name).toBe('Work')
    expect(t2.roots[0]!.files[0]!.title).toBe('new')
  })
  test('parseTreeSort defaults to name', () => {
    expect(parseTreeSort(null)).toBe('name')
    expect(parseTreeSort('junk')).toBe('name')
    expect(parseTreeSort('modified')).toBe('modified')
  })
  test('allDirRels lists every folder for collapse-all', () => {
    expect(allDirRels(buildTree(notes, titleOf)).sort()).toEqual(['Work', 'Work/deep', 'personal'])
  })
})

describe('drag auto-scroll', () => {
  test('scrolls up near the top, down near the bottom, not in the middle', async () => {
    const { dragScrollStep, DRAG_SCROLL_EDGE } = await import('./FolderTree')
    expect(dragScrollStep(500, 0, 1000)).toBe(0)
    expect(dragScrollStep(5, 0, 1000)).toBeLessThan(0)
    expect(dragScrollStep(995, 0, 1000)).toBeGreaterThan(0)
    // Closer to the edge scrolls faster.
    expect(Math.abs(dragScrollStep(1, 0, 1000))).toBeGreaterThan(
      Math.abs(dragScrollStep(DRAG_SCROLL_EDGE - 4, 0, 1000))
    )
    // Too short to have edges: never scroll.
    expect(dragScrollStep(1, 0, 60)).toBe(0)
  })
})
