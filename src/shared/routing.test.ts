import { describe, expect, test } from 'bun:test'
import {
  appendHint,
  applyAiRoute,
  aiRoutePrompt,
  DEFAULT_ROUTING_PREFS,
  KEEP_IN_INBOX,
  parseRouteHint,
  previewLabel,
  decideRoute,
  ftsQuery,
  inferTags,
  keyTerms,
  normalizeToVocab,
  parseAiRoute,
  pickMeetingsFolder,
  routeSummary,
  sanitizeRoutingPrefs,
  tagVocab,
  type RouteDoc,
  type RouteFolder,
  type RouteInput
} from './routing'

const folders: RouteFolder[] = [
  { name: 'Garden', dir: 'Garden' },
  { name: 'Meetings', dir: 'Meetings' },
  { name: 'Recipes', dir: 'Recipes' },
  { name: 'Rust', dir: 'Rust' }
]

const docs: RouteDoc[] = [
  {
    path: 'Garden/Tomato log.md',
    title: 'Tomato log',
    kind: 'text',
    tags: ['tomatoes'],
    body: 'planted roma tomato seedlings, compost, staking, watering schedule for tomato beds'
  },
  {
    path: 'Garden/Compost.md',
    title: 'Compost',
    kind: 'text',
    tags: ['compost'],
    body: 'compost bin turning, worms, garden beds mulch'
  },
  {
    path: 'Recipes/Pasta.md',
    title: 'Pasta sauce',
    kind: 'text',
    tags: ['cooking'],
    body: 'tomato sauce with garlic and basil, simmer forty minutes'
  },
  {
    path: 'Rust/Borrow checker.md',
    title: 'Borrow checker',
    kind: 'text',
    tags: ['rust'],
    body: 'lifetimes, borrow checker, ownership, async traits'
  },
  {
    path: 'Meetings/2026-10-20 0900 Standup.md',
    title: 'Standup',
    kind: 'meeting',
    tags: ['meeting'],
    body: 'transcript: we talked about the garden project, tomato planning, release schedule, compost, rust'
  },
  {
    path: 'Meetings/2026-10-21 0900 Standup.md',
    title: 'Standup',
    kind: 'meeting',
    tags: ['meeting'],
    body: 'transcript: rust lifetimes, garden, deploy'
  }
]

const notes = docs.map(({ path, kind, tags }) => ({ path, kind, tags }))
const noAppend = { ...DEFAULT_ROUTING_PREFS, allowAppend: false }

const input = (raw: string, over: Partial<RouteInput> = {}): RouteInput => ({
  raw,
  kind: 'text',
  folders,
  notes,
  docs,
  prefs: DEFAULT_ROUTING_PREFS,
  ...over
})

describe('decideRoute', () => {
  test('no projects[0] fallback: unrelated capture → review', () => {
    const d = decideRoute(input('call the dentist about the crown on thursday'))
    expect(d.action).toBe('review')
    expect(d.folder).toBeNull()
    expect(d.reason).toContain('left in inbox')
  })

  test('Meetings folder does not win unrelated or loosely related captures', () => {
    const d = decideRoute(input('release schedule deploy checklist for friday'))
    expect(d.folder).not.toBe('Meetings')
    // Alphabetical order never matters: Garden (first) doesn't win either.
    expect(d.action).toBe('review')
    expect(decideRoute(input('xyzzy plugh')).folder).toBeNull()
  })

  test('picks the folder by content, not by folder name', () => {
    const d = decideRoute(input('worms in the compost bin, add more mulch to the beds', { prefs: noAppend }))
    expect(d.action).toBe('new')
    expect(d.folder).toBe('Garden')
    expect(d.reason).toContain('Garden')
    const r = decideRoute(input('ownership and lifetimes again, async traits are confusing', { prefs: noAppend }))
    expect(r.folder).toBe('Rust')
  })

  test('append when one note is clearly related, new otherwise', () => {
    const raw = 'tomato seedlings need staking, change the watering schedule'
    const a = decideRoute(input(raw))
    expect(a.action).toBe('append')
    expect(a.target).toBe('Garden/Tomato log.md')
    expect(a.folder).toBe('Garden')
    expect(a.reason).toContain('Tomato log')

    const n = decideRoute(input(raw, { prefs: { ...DEFAULT_ROUTING_PREFS, appendThreshold: 0.99 } }))
    expect(n.action).toBe('new')
    expect(n.folder).toBe('Garden')

    expect(decideRoute(input(raw, { prefs: noAppend })).action).toBe('new')
  })

  test('meeting notes and day logs are never append targets by default', () => {
    const raw = 'standup transcript garden project tomato planning release schedule compost rust'
    const meetingsOnly = docs.filter((x) => x.kind === 'meeting')
    expect(decideRoute(input(raw, { docs: meetingsOnly })).action).not.toBe('append')
    const allowed = decideRoute(
      input(raw, { docs: meetingsOnly, prefs: { ...DEFAULT_ROUTING_PREFS, appendToMeetings: true } })
    )
    expect(allowed.notes[0]?.appendable).toBe(true)
  })

  test('explicit hint always wins, even for an unrelated folder', () => {
    const d = decideRoute(input('tomato seedlings need staking', { hint: 'rust' }))
    expect(d.action).toBe('new')
    expect(d.folder).toBe('Rust')
    expect(d.provider).toBe('picker')
  })

  test('meeting captures: content decides unless a meetings folder is set', () => {
    const raw = 'compost bin worms mulch garden beds'
    expect(decideRoute(input(raw, { kind: 'meeting' })).folder).toBe('Garden')
    const d = decideRoute(
      input(raw, { kind: 'meeting', prefs: { ...DEFAULT_ROUTING_PREFS, meetingsFolder: 'meetings' } })
    )
    expect(d.folder).toBe('Meetings')
    expect(d.action).toBe('new')
  })

  test('empty vault: no folders → review', () => {
    const d = decideRoute(input('anything', { folders: [], notes: [], docs: [] }))
    expect(d.action).toBe('review')
    expect(d.reason).toContain('no folders yet')
  })

  test('default folder only when the user set one', () => {
    const d = decideRoute(
      input('call the dentist about the crown', { prefs: { ...DEFAULT_ROUTING_PREFS, defaultFolder: 'Inbox notes' } })
    )
    expect(d.action).toBe('new')
    expect(d.folder).toBe('Inbox notes')
  })
})

describe('tags', () => {
  const vocab = tagVocab([{ tags: ['tomatoes', 'Rust', 'side-project'] }, { tags: ['tomatoes'] }])
  test('explicit #tags + existing vocab mentions, normalized to vault spelling', () => {
    expect(inferTags('the tomato beds and my side project #rust', 'text', vocab)).toEqual([
      'Rust',
      'tomatoes',
      'side-project'
    ])
  })
  test('AI tags snap to close existing tags, new ones kept lowercase', () => {
    expect(normalizeToVocab('Tomato', vocab)).toBe('tomatoes')
    expect(normalizeToVocab('side_project', vocab)).toBe('side-project')
    expect(normalizeToVocab('Gardening', vocab)).toBe('gardening')
  })
})

describe('helpers', () => {
  test('keyTerms drops filler, stems plurals', () => {
    expect(keyTerms('um so the meetings and the meeting notes, tomatoes!')).toEqual(['meeting', 'tomato'])
  })
  test('ftsQuery quotes terms (no FTS syntax injection)', () => {
    expect(ftsQuery(['tomato', 'a"b'])).toBe('"tomato"* OR "ab"*')
  })
  test('parseAiRoute: exact candidates only', () => {
    const cand = { folders: ['Garden', 'Rust'], notes: [] }
    expect(parseAiRoute('{"action":"new","folder":"Gardening","confidence":0.9}', cand)).toBeNull()
    expect(
      parseAiRoute('sure! {"action":"new","folder":"Garden","title":"t","tags":[],"confidence":0.9}', cand)?.folder
    ).toBe('Garden')
    expect(
      parseAiRoute('{"action":"append","folder":"Garden","targetNote":"Garden/nope.md","confidence":0.9}', cand)?.action
    ).toBe('new')
    expect(parseAiRoute('not json', cand)).toBeNull()
  })
  test('AI can propose a root-level new note when no listed folder fits', () => {
    const cand = { folders: [], notes: [] }
    const prompt = aiRoutePrompt('call the dentist about Thursday', cand, true)
    expect(prompt.system).toContain('folder ""')
    const ai = parseAiRoute(
      '{"action":"new","folder":"","title":"Dentist appointment","tags":["personal"],"confidence":0.3}',
      cand
    )
    expect(ai).toMatchObject({ action: 'new', folder: '', title: 'Dentist appointment' })
    const result = applyAiRoute(
      decideRoute(input('call the dentist about Thursday')),
      ai!,
      'api',
      DEFAULT_ROUTING_PREFS,
      new Map()
    )
    expect(result).toMatchObject({ action: 'new', folder: '', provider: 'api' })
    const configured = decideRoute(
      input('call the dentist about Thursday', { prefs: { ...DEFAULT_ROUTING_PREFS, defaultFolder: 'Unsorted' } })
    )
    expect(applyAiRoute(configured, ai!, 'api', DEFAULT_ROUTING_PREFS, new Map())).toMatchObject({
      action: 'new',
      folder: 'Unsorted'
    })
  })
  test('prefs sanitize: no default folder, clamps, strips ..', () => {
    expect(sanitizeRoutingPrefs({})).toEqual(DEFAULT_ROUTING_PREFS)
    expect(DEFAULT_ROUTING_PREFS.defaultFolder).toBe('')
    expect(DEFAULT_ROUTING_PREFS.meetingsFolder).toBe('')
    const p = sanitizeRoutingPrefs({ appendThreshold: 7, defaultFolder: '../x/', autoFile: 'yes' })
    expect(p.appendThreshold).toBe(1)
    expect(p.defaultFolder).toBe('x')
    expect(p.autoFile).toBe(true)
  })
})

describe('routeSummary', () => {
  const base = {
    folder: 'Garden',
    rel: 'Garden/Tomato log.md',
    reason: 'r',
    confidence: 0.8,
    provider: 'rules',
    suggested: false
  }
  test('says new vs appended vs review vs suggested', () => {
    expect(routeSummary({ ...base, action: 'append' }, 'ready')).toBe('added to Tomato log')
    expect(routeSummary({ ...base, action: 'new', rel: 'Garden/x.md' }, 'ready')).toBe('new note in Garden')
    expect(routeSummary({ ...base, action: 'review', folder: '', rel: '' }, 'inbox')).toBe('needs review')
    expect(routeSummary({ ...base, action: 'new', rel: '', suggested: true }, 'inbox')).toBe(
      'suggested: new note in Garden'
    )
    expect(
      routeSummary(
        { ...base, action: 'new', title: 'Dentist appointment', rel: '2026-10-26-dentist.md', suggested: true },
        'inbox'
      )
    ).toBe('suggested: new note "Dentist appointment" at 2026-10-26-dentist.md')
    expect(routeSummary({ ...base, action: 'append', suggested: true }, 'inbox')).toBe('suggested: add to Tomato log')
    expect(routeSummary(undefined, 'inbox')).toBe('')
  })
})

describe('pickMeetingsFolder', () => {
  test('setting, then earlier pick, then where meetings already live, else vault root', () => {
    expect(pickMeetingsFolder('Calls', 'Old', ['A/x.md'])).toBe('Calls')
    expect(pickMeetingsFolder('', 'Old', ['A/x.md'])).toBe('Old')
    expect(pickMeetingsFolder('', null, ['Work/Standups/a.md', 'Work/Standups/b.md', 'Other/c.md'])).toBe(
      'Work/Standups'
    )
    expect(pickMeetingsFolder('', null, [])).toBe('')
    expect(pickMeetingsFolder('', null, ['root-meeting.md'])).toBe('')
  })
})

describe('route hints + preview label', () => {
  test('parseRouteHint', () => {
    expect(parseRouteHint('auto')).toEqual({ kind: 'auto' })
    expect(parseRouteHint(undefined)).toEqual({ kind: 'auto' })
    expect(parseRouteHint(KEEP_IN_INBOX)).toEqual({ kind: 'inbox' })
    expect(parseRouteHint(appendHint('Garden/Tomato log.md'))).toEqual({ kind: 'append', rel: 'Garden/Tomato log.md' })
    expect(parseRouteHint('Garden')).toEqual({ kind: 'folder', name: 'Garden' })
  })

  test('previewLabel', () => {
    const base = {
      folder: 'Garden',
      target: null,
      tags: [],
      confidence: 0.72,
      reason: '',
      override: false,
      suggested: false,
      aiMayRefine: false,
      alt: { folder: null, append: null }
    }
    const tomato = { rel: 'Garden/Tomato log.md', title: 'Tomato log' }
    expect(previewLabel({ ...base, action: 'new' })).toBe('→ Garden · new note · 72%')
    expect(previewLabel({ ...base, action: 'append', confidence: 0.81, target: tomato })).toBe(
      '→ add to Tomato log · 81%'
    )
    expect(previewLabel({ ...base, action: 'inbox' })).toBe('→ inbox (not sure)')
    expect(previewLabel({ ...base, action: 'inbox', override: true })).toBe('→ keep in inbox')
    expect(previewLabel({ ...base, action: 'new', suggested: true })).toBe('suggested → Garden · new note · 72%')
    expect(previewLabel({ ...base, action: 'new', override: true })).toBe('→ Garden · new note')
  })
})
