import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { useStore } from './store';
import { decodePairUri, findMac, httpRemote, markDone, pairWithMac, runSync, type MacPeer, type SyncReport } from './sync';
import { androidFs, forgetMac, loadIdentity, random, saveIdentity, stateFor } from './syncfs';

export type SyncPhase = 'unpaired' | 'idle' | 'finding' | 'syncing' | 'offline' | 'error';

interface SyncCtx {
  phase: SyncPhase;
  mac: MacPeer | null;
  lastSync: number | null;
  lastReport: SyncReport | null;
  error: string | null;
  /** Pair from a scanned QR string. Resolves with the Mac's name. */
  pair: (qr: string) => Promise<string>;
  unpair: () => Promise<void>;
  syncNow: () => Promise<void>;
  /** Debounced sync after a local change (capture, save). */
  nudge: () => void;
}

const Ctx = createContext<SyncCtx | null>(null);
const fetchFn = fetch as unknown as Parameters<typeof httpRemote>[0];

function deviceName(): string {
  const c = Platform.constants as { Model?: string; Brand?: string };
  return (c.Model || c.Brand || 'Android').slice(0, 40);
}

/**
 * Phone-driven LAN sync with the paired Mac: on launch, on returning to the
 * app, a few seconds after local edits, and on "Sync now". Finds the Mac on
 * the current Wi-Fi; if it isn't there, it quietly reports "offline".
 */
export function SyncProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { refresh, notes, inbox } = useStore();
  const [id, setId] = useState<string | null>(null);
  const [mac, setMac] = useState<MacPeer | null>(null);
  const [phase, setPhase] = useState<SyncPhase>('unpaired');
  const [error, setError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const macRef = useRef<MacPeer | null>(null);
  macRef.current = mac;

  useEffect(() => {
    void loadIdentity().then((v) => {
      setId(v.id);
      setMac(v.mac);
      setPhase(v.mac ? 'idle' : 'unpaired');
    });
  }, []);

  const persistMac = useCallback(
    async (m: MacPeer | null) => {
      if (!id) return;
      setMac(m);
      await saveIdentity({ id, mac: m });
    },
    [id]
  );

  const syncNow = useCallback(async () => {
    const peer = macRef.current;
    if (!peer || !id) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    setError(null);
    try {
      do {
        again.current = false;
        setPhase('finding');
        const host = await findMac(fetchFn, peer);
        if (!host) {
          setPhase('offline');
          return;
        }
        setPhase('syncing');
        const remote = httpRemote(fetchFn, host, peer, id, random);
        const report = await runSync({ fs: androidFs, remote, state: stateFor(peer.id), remoteName: peer.name });
        await markDone(fetchFn, host, peer, id, random).catch(() => undefined);
        setLastReport(report);
        await persistMac({ ...peer, lastHost: host, lastSync: Date.now() });
        if (report.changedLocal.length) await refresh();
        setPhase('idle');
      } while (again.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    } finally {
      running.current = false;
    }
  }, [id, persistMac, refresh]);

  const nudge = useCallback(() => {
    if (!macRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void syncNow(), 4000);
  }, [syncNow]);

  // Local edits (captures, saves, routing) → sync a few seconds later.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    nudge();
  }, [notes, inbox, nudge]);

  // Launch + foreground.
  useEffect(() => {
    if (!id || !mac) return;
    const t = setTimeout(() => void syncNow(), 1500);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void syncNow();
      else if (s === 'background' && timer.current) {
        clearTimeout(timer.current);
        void syncNow(); // flush pending edits before Android freezes us
      }
    });
    return () => {
      clearTimeout(t);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mac?.id]);

  const pair = useCallback(
    async (qr: string) => {
      if (!id) throw new Error('Still starting up, try again in a moment.');
      const payload = decodePairUri(qr);
      if (!payload) throw new Error("That isn't an Inkfish pairing code.");
      const peer = await pairWithMac(fetchFn, payload, { id, name: deviceName() }, random);
      await persistMac(peer);
      setPhase('idle');
      setTimeout(() => void syncNow(), 300);
      return peer.name;
    },
    [id, persistMac, syncNow]
  );

  const unpair = useCallback(async () => {
    if (!id) return;
    const v = await forgetMac({ id, mac: macRef.current });
    setMac(v.mac);
    setPhase('unpaired');
    setLastReport(null);
  }, [id]);

  const value = useMemo(
    () => ({ phase, mac, lastSync: mac?.lastSync ?? null, lastReport, error, pair, unpair, syncNow, nudge }),
    [phase, mac, lastReport, error, pair, unpair, syncNow, nudge]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSync outside SyncProvider');
  return c;
}
