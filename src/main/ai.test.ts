import { describe, expect, test } from 'bun:test'
import { classify, summarize, summarizeExtractive, providerStatus } from './ai'
import type { Project } from '../shared/types'

const projects: Project[] = [
  { id: 'personal', name: 'personal', dir: 'projects/personal' },
  { id: 'work', name: 'work', dir: 'projects/work' }
]

describe('classify (rules engine, offline)', () => {
  test('explicit hint wins with confidence 1', async () => {
    const r = await classify({ raw: 'anything at all', kind: 'text', projects, projectHint: 'work' })
    expect(r.projectName).toBe('work')
    expect(r.confidence).toBe(1)
    expect(r.provider).toBe('rules')
  })

  test('auto routes on keyword, extracts title + tags', async () => {
    const r = await classify({
      raw: 'Work sprint: ship it #urgent\n- item one',
      kind: 'text',
      projects
    })
    expect(r.projectName).toBe('work')
    expect(r.title).toBe('Work sprint: ship it #urgent')
    expect(r.tags).toContain('urgent')
  })

  test('falls back to first project when nothing matches', async () => {
    const r = await classify({ raw: 'xyzzy unrelated', kind: 'text', projects })
    expect(r.projectName).toBe('personal')
    expect(r.confidence).toBeLessThan(0.5)
  })

  test('meeting kind keeps body, tags the kind', async () => {
    const r = await classify({ raw: 'standup notes', kind: 'meeting', projects })
    expect(r.tags).toContain('meeting')
  })
})

describe('summarize', () => {
  test('extractive picks first sentences', () => {
    expect(summarizeExtractive('One. Two. Three. Four.', 2)).toBe('One.  Two.')
  })

  test('offline summarize falls back to rules', async () => {
    const r = await summarize('Alpha. Beta. Gamma. Delta.')
    expect(r.provider).toBe('rules')
    expect(r.text).toContain('Alpha.')
  })
})

describe('providerStatus', () => {
  test('rules always available, shape stable', async () => {
    const ps = await providerStatus()
    expect(ps.map((p) => p.id)).toEqual(['apple', 'rules', 'stt'])
    expect(ps.find((p) => p.id === 'rules')?.available).toBe(true)
  })
})
