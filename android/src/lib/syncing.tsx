import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { Alert, AppState, Platform } from 'react-native'
import { useStore } from './store'
import {
  assertCompatible,
  decodePairUri,
  findMacHello,
  httpRemote,
  markDone,
  pairWithMac,
  progressPoster,
  runFromReport,
  runSync,
  supportsProgress,
  SyncCancelled,
  SyncHeld,
  SyncIncompatible,
  HttpError,
  type BigDelete,
  type DiscoveryObserver,
  type GuardChoice,
  type MacPeer,
  type SyncProgress,
  type SyncReport
} from './sync'
import { androidFs, forgetMac, loadIdentity, random, saveIdentity, stateFor } from './syncfs'
import { appendSyncLog, readSyncLog, type SyncLogEntry } from './synclog'
import { monotonicNow, SyncStageTimer } from './synctimings'
import { shortError } from './sync'
import { recordMoves } from './vault'
import { afterSync } from './syncafter'
import { progressWorthRender } from './syncstatus'

export type SyncPhase = 'unpaired' | 'idle' | 'finding' | 'syncing' | 'offline' | 'held' | 'error' | 'outdated'

/** What we last learned about the paired Mac (Settings › Sync details). */
export interface MacInfo {
  host: string
  port: number
  protocol: number
  features: string[]
  seenAt: number
}

interface SyncCtx {
  phase: SyncPhase
  /** Live progress while a sync runs (throttled by the engine; null when idle). */
  progress: SyncProgress | null
  macInfo: MacInfo | null
  mac: MacPeer | null
  lastSync: number | null
  lastReport: SyncReport | null
  error: string | null
  /** Phase 'outdated': which app needs updating before sync works again. */
  outdated: 'mac' | 'phone' | null
  /** A big deletion waiting on the user (phase 'held'). */
  held: BigDelete | null
  /** Newest-last session history (Settings › Sync › Recent). */
  log: SyncLogEntry[]
  /** Pair from a scanned QR string. Resolves with the Mac's name. */
  pair: (qr: string, onStage?: (stage: string) => void, onDiscovery?: DiscoveryObserver) => Promise<string>
  unpair: () => Promise<void>
  syncNow: () => Promise<void>
  /**
   * One-shot repair: rehash every file, copy anything either side is missing
   * (never deletes), and trash identical duplicate copies. For when the two
   * devices disagree and a normal sync doesn't fix it.
   */
  repair: () => Promise<void>
  /** Debounced sync after a local change (capture, save). */
  nudge: () => void
}

const Ctx = createContext<SyncCtx | null>(null)

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? '' : 's'}`
}

/** Ask before applying a big deletion. Only while the app is on screen; otherwise hold. */
function askDelete(d: BigDelete, macName: string): Promise<GuardChoice> {
  if (AppState.currentState !== 'active') return Promise.resolve('hold')
  const parts: string[] = []
  if (d.local.length) parts.push(`${plural(d.local.length, 'file')} were deleted on ${macName}`)
  if (d.remote.length) parts.push(`${plural(d.remote.length, 'file')} were deleted on this phone`)
  const sample = [...d.local, ...d.remote]
    .slice(0, 4)
    .map((p) => `• ${p.replace(/\.md$/, '')}`)
    .join('\n')
  const more = d.local.length + d.remote.length > 4 ? '\n…' : ''
  return new Promise((resolve) =>
    Alert.alert(
      'Delete these notes everywhere?',
      `${parts.join(' and ')}. Keep them and sync copies them back.\n\n${sample}${more}`,
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve('hold') },
        { text: 'Delete everywhere', style: 'destructive', onPress: () => resolve('apply') },
        { text: 'Keep them', onPress: () => resolve('keep') }
      ],
      { cancelable: true, onDismiss: () => resolve('hold') }
    )
  )
}
const fetchFn = fetch as unknown as Parameters<typeof httpRemote>[0]

/** Network-level failure (no answer at all), as opposed to the Mac saying no. */
function lostConnection(e: unknown): boolean {
  if (e instanceof HttpError || e instanceof SyncIncompatible || e instanceof SyncHeld) return false
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e)
  return /network request failed|aborted|AbortError|timeout|ECONN|EHOSTUNREACH|socket/i.test(m)
}

function deviceName(): string {
  const c = Platform.constants as { Model?: string; Brand?: string }
  return (c.Model || c.Brand || 'Android').slice(0, 40)
}

/**
 * Phone-driven LAN sync with the paired Mac: on launch, on returning to the
 * app, a few seconds after local edits, and on "Sync now". Finds the Mac on
 * the current Wi-Fi; if it isn't there, it quietly reports "offline".
 */
export function SyncProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { refresh, notes, inbox, indexed } = useStore()
  const [id, setId] = useState<string | null>(null)
  const [mac, setMac] = useState<MacPeer | null>(null)
  const [phase, setPhase] = useState<SyncPhase>('unpaired')
  const [error, setError] = useState<string | null>(null)
  const [outdated, setOutdated] = useState<'mac' | 'phone' | null>(null)
  const [lastReport, setLastReport] = useState<SyncReport | null>(null)
  const [held, setHeld] = useState<BigDelete | null>(null)
  const [log, setLog] = useState<SyncLogEntry[]>([])
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [macInfo, setMacInfo] = useState<MacInfo | null>(null)
  const running = useRef(false)
  /** Last progress actually rendered (ticks between are thinned, see progressWorthRender). */
  const shownProgress = useRef<SyncProgress | null>(null)
  const shownAt = useRef(0)
  const again = useRef(false)
  const repairNext = useRef(false)
  /** Cancels the running sync (unpair). Fresh per run. */
  const abort = useRef<AbortController | null>(null)
  /** Note changes before this time come from a sync's own refresh: don't nudge another sync. */
  const quietUntil = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const macRef = useRef<MacPeer | null>(null)
  macRef.current = mac

  useEffect(() => {
    void loadIdentity().then((v) => {
      setId(v.id)
      setMac(v.mac)
      setPhase(v.mac ? 'idle' : 'unpaired')
    })
    void readSyncLog()
      .then(setLog)
      .catch(() => undefined)
  }, [])

  const persistMac = useCallback(
    async (m: MacPeer | null) => {
      if (!id) return
      setMac(m)
      await saveIdentity({ id, mac: m })
    },
    [id]
  )

  const run = useCallback(
    async (opts: { repair?: boolean } = {}) => {
      const peer = macRef.current
      if (!peer || !id) return
      if (opts.repair) repairNext.current = true
      if (running.current) {
        again.current = true
        return
      }
      running.current = true
      abort.current = new AbortController()
      setError(null)
      let stageTimer: SyncStageTimer | null = null
      const done = async (e: SyncLogEntry): Promise<void> => {
        await appendSyncLog(e)
        readSyncLog()
          .then(setLog)
          .catch(() => undefined)
      }
      try {
        do {
          again.current = false
          const t0 = Date.now()
          stageTimer = new SyncStageTimer(monotonicNow)
          stageTimer.enter('finding')
          setPhase('finding')
          const t1 = Date.now()
          setProgress({ stage: 'finding', done: 0, total: 0, bytesDone: 0, bytesTotal: 0, startedAt: t1, stageAt: t1 })
          const found = await findMacHello(fetchFn, peer)
          if (!found) {
            setPhase('offline')
            await done({
              at: Date.now(),
              peer: peer.name,
              kind: 'error',
              message: 'Mac not found on this Wi-Fi',
              stageMs: stageTimer.finish()
            })
            return
          }
          // Handshake: an older/newer Mac we can't talk to → "update Mac" / "update phone", not a silent failure.
          assertCompatible(found.hello)
          setOutdated(null)
          const host = found.host
          setMacInfo({
            host,
            port: peer.port,
            protocol: found.hello.protocol ?? found.hello.v ?? 1,
            features: Array.isArray(found.hello.features) ? found.hello.features : [],
            seenAt: Date.now()
          })
          setPhase('syncing')
          // Newer Macs show this phone's progress live (a request a second at most; older Macs skip it).
          const poster = supportsProgress(found.hello) ? progressPoster(fetchFn, host, peer, id, random) : null
          const tRun = Date.now()
          // Remember where the Mac answered right away, so an interrupted run reconnects fast next time.
          if (peer.lastHost !== host) await persistMac({ ...peer, lastHost: host }).catch(() => undefined)
          const remote = httpRemote(fetchFn, host, peer, id, random, {
            features: Array.isArray(found.hello.features) ? found.hello.features : [],
            retry: { attempts: 4, signal: abort.current?.signal }
          })
          const repair = repairNext.current
          repairNext.current = false
          const report = await runSync({
            repair,
            signal: abort.current?.signal,
            onProgress: (p) => {
              stageTimer?.enter(p.stage)
              const now = Date.now()
              if (progressWorthRender(shownProgress.current, p, shownAt.current, now)) {
                shownProgress.current = p
                shownAt.current = now
                setProgress(p)
              }
              poster?.post(p)
            },
            fs: androidFs,
            remote,
            state: stateFor(peer.id),
            remoteName: peer.name,
            confirmDelete: (d) => askDelete(d, peer.name)
          })
          const stageMs = stageTimer.finish()
          setHeld(null)
          await poster?.flush().catch(() => undefined)
          await markDone(fetchFn, host, peer, id, random, runFromReport(report, Date.now(), Date.now() - tRun)).catch(
            () => undefined
          )
          const after = afterSync(report)
          // Renames that arrived as moves (or case adoptions): let an open note follow its file.
          recordMoves(after.moves)
          setLastReport(report)
          await persistMac({ ...peer, lastHost: host, lastSync: Date.now() })
          // Always: list, drawer and open note pick up pulls/moves/deletes now, not on restart.
          if (after.refresh) {
            quietUntil.current = Date.now() + after.quietMs
            await refresh()
            quietUntil.current = Date.now() + after.quietMs
          }
          await done({
            at: Date.now(),
            peer: peer.name,
            kind: 'sync',
            pulled: report.pulled,
            pushed: report.pushed,
            merged: report.merged,
            conflicts: report.conflicts,
            deleted: report.deleted,
            moved: report.moved,
            ms: Date.now() - t0,
            stageMs,
            ...(repair || after.note
              ? { message: [repair ? 'repair' : '', after.note ?? ''].filter(Boolean).join(' · ') }
              : {})
          })
          setPhase('idle')
        } while (again.current)
      } catch (e) {
        const stageMs = stageTimer?.finish()
        if (e instanceof SyncIncompatible) {
          setOutdated(e.app)
          setError(e.message)
          setPhase('outdated')
          await done({ at: Date.now(), peer: peer.name, kind: 'error', message: e.message, stageMs })
          return
        }
        if (e instanceof SyncHeld) {
          setHeld(e.pending)
          setPhase('held')
          await done({
            at: Date.now(),
            peer: peer.name,
            kind: 'hold',
            message: `${e.pending.local.length + e.pending.remote.length} files would be deleted — waiting for choice`,
            stageMs
          })
          return
        }
        if (e instanceof SyncCancelled) {
          setPhase(macRef.current ? 'idle' : 'unpaired')
          return
        }
        const message = shortError(e)
        // Lost the Mac mid-run (Wi-Fi dropped, Mac asleep, app backgrounded): that's "offline",
        // not an error. What landed stays; the next run picks up from there.
        if (lostConnection(e)) {
          setPhase('offline')
          await done({
            at: Date.now(),
            peer: peer.name,
            kind: 'error',
            message: `connection lost — ${message}`,
            stageMs
          })
          return
        }
        setError(message)
        setPhase('error')
        await done({ at: Date.now(), peer: peer.name, kind: 'error', message, stageMs })
      } finally {
        running.current = false
        shownProgress.current = null
        setProgress(null)
      }
    },
    [id, persistMac, refresh]
  )

  const syncNow = useCallback(() => run(), [run])
  const repair = useCallback(() => run({ repair: true }), [run])

  const nudge = useCallback(() => {
    if (!macRef.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void syncNow(), 4000)
  }, [syncNow])

  // Local edits (captures, saves, routing) → sync a few seconds later.
  // Launch fills the lists twice (saved index, then the fresh scan): neither is an edit.
  const first = useRef(true)
  useEffect(() => {
    if (!indexed) return
    if (first.current) {
      first.current = false
      return
    }
    if (Date.now() < quietUntil.current) return // our own post-sync refresh, not a local edit
    nudge()
  }, [notes, inbox, nudge, indexed])

  // Launch + foreground. The launch sync waits for the first index scan, so the
  // sync walk never competes with the drawer for the file-system bridge.
  useEffect(() => {
    if (!id || !mac || !indexed) return
    const t = setTimeout(() => void syncNow(), 1500)
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void refresh() // files may have changed out from under us (sync, restore)
        void syncNow()
      } else if (s === 'background' && timer.current) {
        clearTimeout(timer.current)
        void syncNow() // flush pending edits before Android freezes us
      }
    })
    // While the app sits open, poll the Mac so its edits appear without
    // forcing the user to background/foreground. Manifest-only when idle.
    const iv = setInterval(() => {
      if (AppState.currentState === 'active') void syncNow()
    }, 90_000)
    return () => {
      clearTimeout(t)
      clearInterval(iv)
      sub.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mac?.id, indexed])

  const pair = useCallback(
    async (qr: string, onStage?: (stage: string) => void, onDiscovery?: DiscoveryObserver) => {
      if (!id) throw new Error('Still starting up, try again in a moment.')
      const payload = decodePairUri(qr)
      if (!payload) throw new Error("That isn't an Inkfish pairing code.")
      const peer = await pairWithMac(
        fetchFn,
        payload,
        { id, name: deviceName() },
        random,
        Date.now(),
        onStage,
        onDiscovery
      )
      await persistMac(peer)
      setPhase('idle')
      setTimeout(() => void syncNow(), 300)
      return peer.name
    },
    [id, persistMac, syncNow]
  )

  const unpair = useCallback(async () => {
    if (!id) return
    abort.current?.abort()
    const v = await forgetMac({ id, mac: macRef.current })
    setMac(v.mac)
    setPhase('unpaired')
    setLastReport(null)
  }, [id])

  const value = useMemo(
    () => ({
      phase,
      progress,
      macInfo,
      mac,
      lastSync: mac?.lastSync ?? null,
      lastReport,
      error,
      outdated,
      held,
      log,
      pair,
      unpair,
      syncNow,
      repair,
      nudge
    }),
    [phase, progress, macInfo, mac, lastReport, error, outdated, held, log, pair, unpair, syncNow, repair, nudge]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSync(): SyncCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useSync outside SyncProvider')
  return c
}
