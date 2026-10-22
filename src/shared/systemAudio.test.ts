import { describe, expect, test } from 'bun:test'
import {
  autoPick,
  DEFAULT_PREFS,
  describeLive,
  describeSource,
  groupApps,
  isPicked,
  loadPrefs,
  parseAudioApps,
  parseSourcesLine,
  pickerRows,
  PREFS_KEY,
  resolveSource,
  savePrefs,
  supportsAppAudio,
  tapArgs,
  toggleApp,
  type AudioApp,
  type AudioProcess
} from './systemAudio'

const proc = (p: Partial<AudioProcess> & { pid: number; appId: string }): AudioProcess => ({
  object: p.pid + 1000,
  bundleId: p.appId,
  appName: '',
  appPath: '',
  outputting: false,
  ...p
})

const TEAMS = '/Applications/Microsoft Teams.app'
const procs: AudioProcess[] = [
  proc({
    pid: 10,
    appId: 'com.microsoft.teams2',
    bundleId: 'com.microsoft.teams2',
    appName: 'Microsoft Teams',
    appPath: TEAMS
  }),
  proc({
    pid: 12,
    appId: 'com.microsoft.teams2',
    bundleId: 'com.microsoft.teams2.helper',
    appName: 'Microsoft Teams',
    appPath: TEAMS,
    outputting: true
  }),
  proc({ pid: 11, appId: 'com.microsoft.teams2', bundleId: 'com.microsoft.teams2.helper.renderer', appPath: TEAMS }),
  proc({
    pid: 20,
    appId: 'com.spotify.client',
    appName: 'Spotify',
    appPath: '/Applications/Spotify.app',
    outputting: true
  }),
  proc({ pid: 30, appId: 'com.google.Chrome', appName: 'Google Chrome', appPath: '/Applications/Google Chrome.app' }),
  proc({ pid: 40, appId: 'com.apple.mediaremoted' }), // daemon, silent → hidden
  proc({ pid: 41, appId: 'com.apple.avconferenced', outputting: true }), // daemon, playing → shown
  proc({ pid: 50, appId: 'com.pylotlight.inkfish', appName: 'Inkfish', appPath: '/Applications/Inkfish.app' }),
  proc({ pid: 51, appId: 'com.github.Electron', bundleId: 'com.github.Electron.helper', appPath: '/x/Electron.app' })
]

const app = (a: Partial<AudioApp> & { id: string; kind: AudioApp['kind'] }): AudioApp => ({
  name: a.id,
  appPath: '',
  pids: [1],
  outputting: false,
  ...a
})

function memStore(init: Record<string, string> = {}): {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  data: Record<string, string>
} {
  const data = { ...init }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

describe('groupApps', () => {
  const apps = groupApps(procs)

  test('folds every helper PID under its owning app', () => {
    const teams = apps.find((a) => a.id === 'com.microsoft.teams2')
    expect(teams?.pids).toEqual([10, 11, 12])
    expect(teams?.name).toBe('Microsoft Teams')
    expect(teams?.outputting).toBe(true)
    expect(teams?.kind).toBe('meeting')
  })

  test('drops Inkfish itself (packaged + dev Electron) and silent daemons', () => {
    const ids = apps.map((a) => a.id)
    expect(ids).not.toContain('com.pylotlight.inkfish')
    expect(ids).not.toContain('com.github.Electron')
    expect(ids).not.toContain('com.apple.mediaremoted')
    expect(ids).toContain('com.apple.avconferenced')
  })

  test('playing first, then meeting apps, browsers, the rest', () => {
    expect(apps.map((a) => a.id)).toEqual([
      'com.microsoft.teams2',
      'com.apple.avconferenced',
      'com.spotify.client',
      'com.google.Chrome'
    ])
    expect(apps.find((a) => a.id === 'com.google.Chrome')?.kind).toBe('browser')
  })

  test('falls back to known names, then bundle id, then pid', () => {
    const [z, b, p] = groupApps([
      proc({ pid: 1, appId: 'us.zoom.xos', bundleId: '', outputting: true }),
      proc({ pid: 2, appId: '', bundleId: 'com.example.thing', outputting: true }),
      proc({ pid: 3, appId: '', bundleId: '', outputting: true })
    ])
    expect(z?.name).toBe('Zoom')
    expect(b?.id).toBe('com.example.thing')
    expect(p?.id).toBe('pid:3')
  })
})

describe('autoPick', () => {
  test('picks a playing meeting app over music', () => {
    expect(autoPick(groupApps(procs))).toEqual([{ id: 'com.microsoft.teams2', name: 'Microsoft Teams' }])
  })

  test('meeting app that is not playing yet is not picked', () => {
    const apps = [
      app({ id: 'us.zoom.xos', kind: 'meeting' }),
      app({ id: 'com.spotify.client', kind: 'other', outputting: true })
    ]
    expect(autoPick(apps)).toBeNull()
  })

  test('browser (Meet in a tab) only when no native meeting app plays', () => {
    const chrome = app({ id: 'com.google.Chrome', name: 'Chrome', kind: 'browser', outputting: true })
    expect(autoPick([chrome])).toEqual([{ id: 'com.google.Chrome', name: 'Chrome' }])
    const zoom = app({ id: 'us.zoom.xos', name: 'Zoom', kind: 'meeting', outputting: true })
    expect(autoPick([chrome, zoom])).toEqual([{ id: 'us.zoom.xos', name: 'Zoom' }])
  })

  test('several meeting apps playing → all of them', () => {
    const apps = [
      app({ id: 'us.zoom.xos', name: 'Zoom', kind: 'meeting', outputting: true }),
      app({ id: 'com.tinyspeck.slackmacgap', name: 'Slack', kind: 'meeting', outputting: true })
    ]
    expect(autoPick(apps)?.map((a) => a.id)).toEqual(['us.zoom.xos', 'com.tinyspeck.slackmacgap'])
  })
})

describe('resolveSource', () => {
  const apps = groupApps(procs)
  test('a hand-picked choice wins over auto-pick', () => {
    const prefs = { autoPick: true, source: { mode: 'apps' as const, apps: [{ id: 'us.zoom.xos', name: 'Zoom' }] } }
    expect(resolveSource(prefs, apps)).toEqual({ source: prefs.source, auto: false })
  })
  test('all + auto-pick narrows to the playing meeting app', () => {
    const r = resolveSource(DEFAULT_PREFS, apps)
    expect(r.auto).toBe(true)
    expect(r.source).toEqual({ mode: 'apps', apps: [{ id: 'com.microsoft.teams2', name: 'Microsoft Teams' }] })
  })
  test('auto-pick off, or nothing meeting-like playing, or no list → all', () => {
    expect(resolveSource({ ...DEFAULT_PREFS, autoPick: false }, apps)).toEqual({ source: { mode: 'all' }, auto: false })
    expect(resolveSource(DEFAULT_PREFS, [app({ id: 'x', kind: 'other', outputting: true })]).source).toEqual({
      mode: 'all'
    })
    expect(resolveSource(DEFAULT_PREFS, null).source).toEqual({ mode: 'all' })
  })
})

describe('picker state', () => {
  test('toggle adds/removes; empty selection is "all"', () => {
    let s = toggleApp({ mode: 'all' }, { id: 'a', name: 'A' })
    expect(s).toEqual({ mode: 'apps', apps: [{ id: 'a', name: 'A' }] })
    s = toggleApp(s, { id: 'b', name: 'B' })
    expect(isPicked(s, 'b')).toBe(true)
    s = toggleApp(toggleApp(s, { id: 'a', name: 'A' }), { id: 'b', name: 'B' })
    expect(s).toEqual({ mode: 'all' })
  })

  test('remembered app that is not running still shows as a row', () => {
    const rows = pickerRows([app({ id: 'com.spotify.client', kind: 'other' })], {
      mode: 'apps',
      apps: [{ id: 'com.microsoft.teams2', name: 'Microsoft Teams' }]
    })
    expect(rows.map((r) => r.id)).toEqual(['com.spotify.client', 'com.microsoft.teams2'])
    expect(rows[1]?.kind).toBe('meeting')
    expect(rows[1]?.pids).toEqual([])
  })

  test('describeSource', () => {
    expect(describeSource({ mode: 'all' })).toBe('All system audio')
    expect(describeSource({ mode: 'apps', apps: [{ id: 'a', name: 'Teams' }] })).toBe('Teams')
    expect(
      describeSource({
        mode: 'apps',
        apps: [
          { id: 'a', name: 'Zoom' },
          { id: 'b', name: 'Chrome' }
        ]
      })
    ).toBe('Zoom + Chrome')
    expect(
      describeSource({
        mode: 'apps',
        apps: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
          { id: 'c', name: 'C' }
        ]
      })
    ).toBe('A + 2 more')
  })
})

describe('persistence', () => {
  test('defaults: all system audio, auto-pick on', () => {
    expect(loadPrefs(memStore())).toEqual(DEFAULT_PREFS)
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS)
  })

  test('round-trips the last choice', () => {
    const store = memStore()
    const prefs = { autoPick: false, source: { mode: 'apps' as const, apps: [{ id: 'us.zoom.xos', name: 'Zoom' }] } }
    savePrefs(store, prefs)
    expect(JSON.parse(store.data[PREFS_KEY] as string)).toEqual(prefs)
    expect(loadPrefs(store)).toEqual(prefs)
  })

  test('garbage and half-written values fall back safely', () => {
    expect(loadPrefs(memStore({ [PREFS_KEY]: '{not json' }))).toEqual(DEFAULT_PREFS)
    expect(loadPrefs(memStore({ [PREFS_KEY]: '{"source":{"mode":"apps","apps":[]}}' })).source).toEqual({ mode: 'all' })
    expect(
      loadPrefs(
        memStore({
          [PREFS_KEY]: '{"source":{"mode":"apps","apps":[{"id":"a"},{"id":"b","name":"B"},null]},"autoPick":"yes"}'
        })
      )
    ).toEqual({ source: { mode: 'apps', apps: [{ id: 'b', name: 'B' }] }, autoPick: true })
  })

  test('a throwing store never throws', () => {
    const bad = {
      getItem: (): string | null => {
        throw new Error('denied')
      },
      setItem: (): void => {
        throw new Error('full')
      }
    }
    expect(loadPrefs(bad)).toEqual(DEFAULT_PREFS)
    expect(() => savePrefs(bad, DEFAULT_PREFS)).not.toThrow()
  })
})

describe('helper protocol', () => {
  test('tapArgs', () => {
    expect(tapArgs({ mode: 'all' })).toEqual(['tap'])
    expect(
      tapArgs({
        mode: 'apps',
        apps: [
          { id: 'com.microsoft.teams2', name: 'T' },
          { id: 'us.zoom.xos', name: 'Z' },
          { id: 'us.zoom.xos', name: 'Z' }
        ]
      })
    ).toEqual(['tap', '--apps', 'com.microsoft.teams2,us.zoom.xos'])
    // ids that would break the comma list are dropped; nothing left → all
    expect(
      tapArgs({
        mode: 'apps',
        apps: [
          { id: 'a,b', name: 'x' },
          { id: ' ', name: 'y' }
        ]
      })
    ).toEqual(['tap'])
  })

  test('parseSourcesLine', () => {
    const s = parseSourcesLine(
      'SOURCES {"mode":"apps","apps":[{"id":"com.microsoft.teams2","name":"Microsoft Teams","pids":[12,10]}],"waiting":false,"error":""}'
    )
    expect(s).toEqual({
      mode: 'apps',
      apps: [{ id: 'com.microsoft.teams2', name: 'Microsoft Teams', pids: [12, 10] }],
      waiting: false,
      error: ''
    })
    expect(parseSourcesLine('RATE 48000')).toBeNull()
    expect(parseSourcesLine('SOURCES {broken')).toBeNull()
  })

  test('describeLive: waiting, tapping, error, all', () => {
    const wanted = { mode: 'apps' as const, apps: [{ id: 't', name: 'Microsoft Teams' }] }
    expect(describeLive({ mode: 'apps', apps: [], waiting: true, error: '' }, wanted)).toBe(
      'Waiting for Microsoft Teams audio…'
    )
    expect(
      describeLive(
        { mode: 'apps', apps: [{ id: 't', name: 'Microsoft Teams', pids: [1] }], waiting: false, error: '' },
        wanted
      )
    ).toBe('Microsoft Teams')
    expect(describeLive({ mode: 'apps', apps: [], waiting: true, error: 'tap refused' }, wanted)).toBe('tap refused')
    expect(describeLive({ mode: 'all', apps: [], waiting: false, error: '' }, { mode: 'all' })).toBe('All system audio')
  })

  test('parseAudioApps tolerates junk', () => {
    expect(parseAudioApps('nope')).toEqual([])
    expect(parseAudioApps('{"a":1}')).toEqual([])
    const out = parseAudioApps(
      '[{"object":95,"pid":144,"bundleId":"com.apple.AirPlayXPCHelper","appId":"com.apple.AirPlayXPCHelper","appName":"x","appPath":"","outputting":false},{"pid":0},null]'
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.pid).toBe(144)
  })

  test('supportsAppAudio: macOS 14.2+ only (Darwin 23.2)', () => {
    expect(supportsAppAudio('darwin', '23.2.0')).toBe(true)
    expect(supportsAppAudio('darwin', '24.6.0')).toBe(true)
    expect(supportsAppAudio('darwin', '25.0.0')).toBe(true)
    expect(supportsAppAudio('darwin', '23.1.0')).toBe(false)
    expect(supportsAppAudio('darwin', '22.6.0')).toBe(false)
    expect(supportsAppAudio('linux', '6.8.0')).toBe(false)
    expect(supportsAppAudio('win32', '10.0.22631')).toBe(false)
  })
})
