/**
 * Meeting capture: which apps' audio counts as "the call" (macOS 14.2+).
 *
 * The helper (`inkfish-stt audio-apps`) lists every Core Audio client process
 * resolved to its owning app; this module groups them (Teams' many helper
 * PIDs → one "Microsoft Teams"), remembers the user's choice, and auto-picks
 * a known meeting app that's playing audio so background music stays out.
 * Pure — no Electron, no DOM — so it's shared by main and renderer and tested
 * with mocks.
 */

/** One process as `inkfish-stt audio-apps` reports it. */
export interface AudioProcess {
  object: number
  pid: number
  /** Core Audio's bundle id for this process (may be a helper's). */
  bundleId: string
  /** Owning app's bundle id — the grouping and tapping key. */
  appId: string
  appName: string
  /** Owning .app path ('' for daemons). */
  appPath: string
  /** Playing audio right now. */
  outputting: boolean
}

export type AppKind = 'meeting' | 'browser' | 'other'

/** One app (all its helper processes) in the picker. */
export interface AudioApp {
  id: string
  name: string
  appPath: string
  pids: number[]
  outputting: boolean
  kind: AppKind
  /** data: URL, filled in by the main process. */
  icon?: string
}

export interface PickedApp {
  id: string
  name: string
}

/** What the call side taps: everything the Mac plays, or just these apps. */
export type SystemAudioSource = { mode: 'all' } | { mode: 'apps'; apps: PickedApp[] }

export interface SystemAudioPrefs {
  source: SystemAudioSource
  /** With "All system audio": narrow to a known meeting app when one is playing. */
  autoPick: boolean
}

export const DEFAULT_PREFS: SystemAudioPrefs = { source: { mode: 'all' }, autoPick: true }
export const PREFS_KEY = 'inkfish.meeting.sysaudio.v1'

/** Native meeting / call apps, by owning-app bundle id. */
export const MEETING_APPS: Record<string, string> = {
  'com.microsoft.teams2': 'Microsoft Teams',
  'com.microsoft.teams': 'Microsoft Teams (classic)',
  'us.zoom.xos': 'Zoom',
  'Cisco-Systems.Spark': 'Webex',
  'com.webex.meetingmanager': 'Webex Meetings',
  'com.cisco.webexmeetingsapp': 'Webex Meetings',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.apple.FaceTime': 'FaceTime',
  'com.hnc.Discord': 'Discord',
  'com.logmein.GoToMeeting': 'GoTo Meeting',
  'com.goto.GoTo': 'GoTo',
  'com.skype.skype': 'Skype',
  'com.ringcentral.glip': 'RingCentral',
  'net.whatsapp.WhatsApp': 'WhatsApp',
  'com.amazon.Amazon-Chime': 'Amazon Chime'
}

/** Browsers (Google Meet, Teams/Zoom web). Picked only when no native meeting app is playing. */
export const BROWSERS: Record<string, string> = {
  'com.google.Chrome': 'Google Chrome',
  'com.google.Chrome.beta': 'Google Chrome Beta',
  'com.google.Chrome.canary': 'Google Chrome Canary',
  'com.apple.Safari': 'Safari',
  'com.apple.SafariTechnologyPreview': 'Safari Technology Preview',
  'com.apple.WebKit.GPU': 'Safari (WebKit)',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'company.thebrowser.Browser': 'Arc',
  'org.mozilla.firefox': 'Firefox',
  'com.brave.Browser': 'Brave',
  'com.vivaldi.Vivaldi': 'Vivaldi',
  'com.operasoftware.Opera': 'Opera'
}

/** Never offered: Inkfish itself (packaged + dev Electron) and its helper. */
export const SELF_IDS = new Set(['com.pylotlight.inkfish', 'com.pylotlight.inkfish.stt', 'com.github.Electron'])

export function kindOf(id: string): AppKind {
  if (id in MEETING_APPS) return 'meeting'
  if (id in BROWSERS) return 'browser'
  return 'other'
}

const KIND_RANK: Record<AppKind, number> = { meeting: 0, browser: 1, other: 2 }

/**
 * Processes → apps. Groups by owning app, drops Inkfish itself and nameless
 * daemons that aren't playing anything. Playing apps first, then meeting
 * apps, browsers, the rest; alphabetical within each.
 */
export function groupApps(procs: AudioProcess[], selfIds: Set<string> = SELF_IDS): AudioApp[] {
  const by = new Map<string, AudioApp>()
  for (const p of procs) {
    const id = p.appId || p.bundleId || `pid:${p.pid}`
    if (selfIds.has(id) || selfIds.has(p.bundleId)) continue
    const cur = by.get(id)
    if (cur) {
      if (!cur.pids.includes(p.pid)) cur.pids.push(p.pid)
      cur.outputting ||= p.outputting
      if (!cur.appPath && p.appPath) cur.appPath = p.appPath
      continue
    }
    by.set(id, {
      id,
      name: p.appName || MEETING_APPS[id] || BROWSERS[id] || p.bundleId || id,
      appPath: p.appPath,
      pids: [p.pid],
      outputting: p.outputting,
      kind: kindOf(id)
    })
  }
  return [...by.values()]
    .filter((a) => a.appPath || a.outputting || a.kind !== 'other')
    .map((a) => ({ ...a, pids: [...a.pids].sort((x, y) => x - y) }))
    .sort(
      (a, b) =>
        Number(b.outputting) - Number(a.outputting) ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.name.localeCompare(b.name)
    )
}

/**
 * Which apps to tap when nothing was chosen by hand: every native meeting app
 * that's playing audio; else every playing browser (Meet in a tab). Null =
 * nothing meeting-like is playing → keep all system audio.
 */
export function autoPick(apps: AudioApp[]): PickedApp[] | null {
  const pick = (k: AppKind): PickedApp[] =>
    apps.filter((a) => a.kind === k && a.outputting).map((a) => ({ id: a.id, name: a.name }))
  const meeting = pick('meeting')
  if (meeting.length) return meeting
  const browsers = pick('browser')
  return browsers.length ? browsers : null
}

export interface ResolvedSource {
  source: SystemAudioSource
  /** Chosen by auto-pick (vs. by hand or the "all" default). */
  auto: boolean
}

/** The source a meeting starting now should use. */
export function resolveSource(prefs: SystemAudioPrefs, apps: AudioApp[] | null): ResolvedSource {
  if (prefs.source.mode === 'apps' && prefs.source.apps.length) return { source: prefs.source, auto: false }
  if (prefs.autoPick && apps) {
    const picked = autoPick(apps)
    if (picked) return { source: { mode: 'apps', apps: picked }, auto: true }
  }
  return { source: { mode: 'all' }, auto: false }
}

/** Helper args for a source. Ids are bundle ids: no commas or whitespace. */
export function tapArgs(source: SystemAudioSource): string[] {
  if (source.mode === 'all') return ['tap']
  const ids = [...new Set(source.apps.map((a) => a.id.trim()).filter((id) => id && /^[^,\s]+$/.test(id)))]
  return ids.length ? ['tap', '--apps', ids.join(',')] : ['tap']
}

/** "All system audio" / "Microsoft Teams" / "Zoom + Chrome". */
export function describeSource(source: SystemAudioSource): string {
  if (source.mode === 'all' || source.apps.length === 0) return 'All system audio'
  const names = source.apps.map((a) => a.name)
  return names.length <= 2 ? names.join(' + ') : `${names[0]} + ${names.length - 1} more`
}

/** Toggle one app in a selection; empty selection falls back to "all". */
export function toggleApp(source: SystemAudioSource, app: PickedApp): SystemAudioSource {
  const cur = source.mode === 'apps' ? source.apps : []
  const next = cur.some((a) => a.id === app.id) ? cur.filter((a) => a.id !== app.id) : [...cur, app]
  return next.length ? { mode: 'apps', apps: next } : { mode: 'all' }
}

export function isPicked(source: SystemAudioSource, id: string): boolean {
  return source.mode === 'apps' && source.apps.some((a) => a.id === id)
}

/**
 * Picker rows: live apps plus anything picked that isn't running right now
 * (so a remembered "Teams" stays visible and selected before Teams starts).
 */
export function pickerRows(apps: AudioApp[], source: SystemAudioSource): AudioApp[] {
  if (source.mode !== 'apps') return apps
  const missing = source.apps
    .filter((p) => !apps.some((a) => a.id === p.id))
    .map((p): AudioApp => ({ id: p.id, name: p.name, appPath: '', pids: [], outputting: false, kind: kindOf(p.id) }))
  return [...apps, ...missing]
}

interface KV {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

function cleanApps(v: unknown): PickedApp[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((a): a is PickedApp => !!a && typeof a.id === 'string' && !!a.id && typeof a.name === 'string')
    .map((a) => ({ id: a.id, name: a.name }))
}

export function loadPrefs(store: KV | null): SystemAudioPrefs {
  try {
    const raw = JSON.parse(store?.getItem(PREFS_KEY) ?? '{}') as Partial<{
      source: { mode?: string; apps?: unknown }
      autoPick: unknown
    }>
    const apps = cleanApps(raw.source?.apps)
    return {
      source: raw.source?.mode === 'apps' && apps.length ? { mode: 'apps', apps } : { mode: 'all' },
      autoPick: typeof raw.autoPick === 'boolean' ? raw.autoPick : DEFAULT_PREFS.autoPick
    }
  } catch {
    return { source: { mode: 'all' }, autoPick: DEFAULT_PREFS.autoPick }
  }
}

export function savePrefs(store: KV | null, prefs: SystemAudioPrefs): void {
  try {
    store?.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // storage full / unavailable: the choice just isn't remembered
  }
}

/** Live status from the helper's `SOURCES {json}` stderr lines. */
export interface TapSources {
  mode: 'all' | 'apps'
  apps: { id: string; name: string; pids: number[] }[]
  /** Targeted, but none of the apps has audio processes yet (recording silence). */
  waiting: boolean
  error: string
}

export function parseSourcesLine(line: string): TapSources | null {
  const m = /^SOURCES (\{.*\})\s*$/.exec(line.trim())
  if (!m) return null
  try {
    const j = JSON.parse(m[1] as string) as Partial<TapSources>
    return {
      mode: j.mode === 'apps' ? 'apps' : 'all',
      apps: Array.isArray(j.apps)
        ? j.apps
            .filter((a) => a && typeof a.id === 'string')
            .map((a) => ({
              id: a.id,
              name: String(a.name ?? a.id),
              pids: Array.isArray(a.pids) ? a.pids.map(Number) : []
            }))
        : [],
      waiting: !!j.waiting,
      error: typeof j.error === 'string' ? j.error : ''
    }
  } catch {
    return null
  }
}

/** Status text for the call-side chip while recording. */
export function describeLive(s: TapSources, wanted: SystemAudioSource): string {
  if (s.error) return s.error
  if (s.mode === 'all') return 'All system audio'
  if (s.waiting) return `Waiting for ${describeSource(wanted)} audio…`
  return s.apps.map((a) => a.name).join(' + ') || describeSource(wanted)
}

/** Process taps landed in macOS 14.2 = Darwin 23.2. */
export function supportsAppAudio(platform: string, darwinRelease: string): boolean {
  if (platform !== 'darwin') return false
  const [maj = 0, min = 0] = darwinRelease.split('.').map((n) => Number.parseInt(n, 10) || 0)
  return maj > 23 || (maj === 23 && min >= 2)
}

/** `inkfish-stt audio-apps` stdout → processes (tolerates junk / non-arrays). */
export function parseAudioApps(json: string): AudioProcess[] {
  try {
    const v = JSON.parse(json) as unknown
    if (!Array.isArray(v)) return []
    return v
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => ({
        object: Number(p['object']) || 0,
        pid: Number(p['pid']) || 0,
        bundleId: String(p['bundleId'] ?? ''),
        appId: String(p['appId'] ?? ''),
        appName: String(p['appName'] ?? ''),
        appPath: String(p['appPath'] ?? ''),
        outputting: !!p['outputting']
      }))
      .filter((p) => p.pid > 0)
  } catch {
    return []
  }
}
