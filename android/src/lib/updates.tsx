import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { usePrefs } from './prefs';
import { checkForUpdate, cleanOldDownloads, currentVersion, downloadUpdate, installUpdate, type Release } from './updater';

export type UpdateStatus = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';

interface UpdatesCtx {
  status: UpdateStatus;
  version: string;
  release: Release | null;
  progress: number;
  error: string | null;
  lastChecked: number | null;
  check: () => Promise<void>;
  /** Download (if needed) then open the installer. */
  update: () => Promise<void>;
}

const Ctx = createContext<UpdatesCtx | null>(null);
const RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * App-wide update state: checks GitHub on launch and when the app returns to
 * the foreground (at most every 6 h, if auto-check is on). Home shows a quiet
 * line when an update is waiting; Settings › Updates has the controls.
 */
export function UpdatesProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { prefs } = usePrefs();
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [release, setRelease] = useState<Release | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const file = useRef<string | null>(null);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setStatus('checking');
    setError(null);
    try {
      const r = await checkForUpdate();
      setRelease(r);
      setStatus(r ? (file.current ? 'ready' : 'available') : 'current');
      setLastChecked(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    } finally {
      busy.current = false;
    }
  }, []);

  const update = useCallback(async () => {
    if (!release || busy.current) return;
    busy.current = true;
    setError(null);
    try {
      if (!file.current) {
        setStatus('downloading');
        setProgress(0);
        file.current = await downloadUpdate(release, setProgress);
      }
      setStatus('ready');
      await installUpdate(file.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    } finally {
      busy.current = false;
    }
  }, [release]);

  // Auto-check on launch + on foreground, throttled.
  const lastRef = useRef<number>(0);
  useEffect(() => {
    void cleanOldDownloads();
    if (!prefs.autoUpdate) return;
    const maybe = (): void => {
      if (Date.now() - lastRef.current < RECHECK_MS) return;
      lastRef.current = Date.now();
      void check();
    };
    const t = setTimeout(maybe, 2500);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && maybe());
    return () => {
      clearTimeout(t);
      sub.remove();
    };
  }, [prefs.autoUpdate, check]);

  const value = useMemo(
    () => ({ status, version: currentVersion(), release, progress, error, lastChecked, check, update }),
    [status, release, progress, error, lastChecked, check, update]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUpdates(): UpdatesCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUpdates outside UpdatesProvider');
  return c;
}
