import { describe, expect, test } from 'bun:test'
import { classify, summarize, summarizeExtractive, providerStatus } from './ai'
import type { Project } from '../shared/types'
import { DEFAULT_ROUTING_PREFS } from '../shared/routing'

const projects: Project[] = [
  { id: 'personal', name: 'personal', dir: 'personal' },
  { id: 'work', name: 'work', dir: 'work' }
]

describe('classify (rules engine, offline)', () => {
  test('explicit hint wins with confidence 1', async () => {
    const r = await classify({ raw: 'anything at all', kind: 'text', projects, projectHint: 'work' })
    expect(r.projectName).toBe('work')
    expect(r.confidence).toBe(1)
    expect(r.provider).toBe('picker')
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

  test('never guesses projects[0]: nothing related stays in the inbox for review', async () => {
    const r = await classify({ raw: 'xyzzy unrelated', kind: 'text', projects })
    expect(r.action).toBe('review')
    expect(r.projectName).toBe('')
    expect(r.reason).toContain('left in inbox')
    expect(r.confidence).toBeLessThan(0.5)
  })

  test('low confidence goes to the default folder only when the user set one', async () => {
    const r = await classify({
      raw: 'xyzzy unrelated',
      kind: 'text',
      projects,
      prefs: { ...DEFAULT_ROUTING_PREFS, defaultFolder: 'work' }
    })
    expect(r.action).toBe('new')
    expect(r.projectName).toBe('work')
  })

  test('no folders at all → review, no invented "general"', async () => {
    const r = await classify({ raw: 'anything at all here', kind: 'text', projects: [] })
    expect(r.action).toBe('review')
    expect(r.projectName).toBe('')
  })

  test('AI provider answer is constrained to candidates (exact only)', async () => {
    const bad = await classify({
      raw: 'xyzzy unrelated words here',
      kind: 'text',
      projects,
      llm: async () => '{"action":"new","folder":"the work project","title":"x","tags":[],"confidence":0.9}'
    })
    expect(bad.action).toBe('review')
    const good = await classify({
      raw: 'xyzzy unrelated words here',
      kind: 'text',
      projects,
      llm: async () => '{"action":"new","folder":"personal","title":"Xyzzy","tags":["misc"],"confidence":0.8}'
    })
    expect(good.action).toBe('new')
    expect(good.projectName).toBe('personal')
    expect(good.provider).toBe('api')
    expect(good.title).toBe('Xyzzy')
  })

  test('explicit picker beats the AI provider', async () => {
    const r = await classify({
      raw: 'xyzzy unrelated words here',
      kind: 'text',
      projects,
      projectHint: 'work',
      llm: async () => '{"action":"new","folder":"personal","title":"x","tags":[],"confidence":0.99}'
    })
    expect(r.projectName).toBe('work')
    expect(r.provider).toBe('picker')
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
    expect(ps.map((p) => p.id)).toEqual(['apple', 'intelligence', 'rules', 'stt'])
    expect(ps.find((p) => p.id === 'rules')?.available).toBe(true)
  })
})

describe('Apple Intelligence fallback', () => {
  test('classify stays on rules when the on-device model is unavailable', async () => {
    const r = await classify({ raw: 'um so work thing, ship the settings page by thursday', kind: 'text', projects })
    expect(r.provider).toBe('rules')
    expect(r.projectName).toBe('work')
  })
})
