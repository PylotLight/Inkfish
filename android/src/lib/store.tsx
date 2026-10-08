import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { rulesClassify, type InboxItem, type NoteDoc, type NoteEntry, type NoteKind, type Project } from './format';
import * as vault from './vault';
import { purgeTrash } from './trash';

interface Store {
  ready: boolean;
  error: string | null;
  inbox: InboxItem[];
  notes: NoteEntry[];
  projects: Project[];
  refresh: () => Promise<void>;
  capture: (raw: string, kind: NoteKind, projectHint: string, assets: string[]) => Promise<InboxItem>;
  captureDaily: (raw: string, kind: NoteKind) => Promise<string>;
  routeInbox: (id: string, projectName?: string) => Promise<void>;
  undoInbox: (id: string) => Promise<void>;
  openNote: (id: string) => Promise<NoteDoc | null>;
  saveNote: (id: string, markdown: string) => Promise<NoteDoc | null>;
  newNote: (dir: string, name?: string) => Promise<string>;
  createDir: (parentRel: string, name: string) => Promise<string>;
  deleteFile: (rel: string) => Promise<void>;
  deleteDir: (rel: string) => Promise<void>;
  renameFile: (oldRel: string, newName: string) => Promise<string>;
  renameDir: (oldRel: string, newName: string) => Promise<string>;
  appendDaily: (raw: string, kind: NoteKind) => Promise<string>;
  readDaily: () => Promise<{ rel: string; body: string }>;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [p, ib, n] = await Promise.all([
        vault.ensureSeedProjects(),
        vault.listInbox(),
        vault.listNotes()
      ]);
      setProjects(p);
      setInbox(ib);
      setNotes(n);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void vault
      .ensureTree()
      .then(refresh)
      .then(() => purgeTrash().catch(() => undefined))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setReady(true));
  }, [refresh]);

  const capture = useCallback(
    async (raw: string, kind: NoteKind, projectHint: string, assets: string[]) => {
      const item = await vault.writeInboxItem({ kind, raw, projectHint, source: 'android', assets });
      // Non-blocking auto-route with the rules engine (Mac does this in main).
      await vault.setInboxStatus(item.id, 'processing');
      try {
        const fresh = await vault.listProjects();
        const r = rulesClassify(raw, kind, fresh, projectHint);
        await vault.routeToProject({
          inboxId: item.id,
          projectName: r.projectName,
          title: r.title,
          tags: r.tags,
          markdown: r.markdown,
          kind
        });
        await vault.setInboxStatus(item.id, 'ready');
      } catch {
        await vault.setInboxStatus(item.id, 'inbox');
      }
      await refresh();
      return item;
    },
    [refresh]
  );

  const captureDaily = useCallback(
    async (raw: string, kind: NoteKind) => {
      const rel = await vault.appendDaily(raw, kind);
      await refresh();
      return rel;
    },
    [refresh]
  );

  const routeInbox = useCallback(
    async (id: string, projectName?: string) => {
      const items = await vault.listInbox();
      const item = items.find((i) => i.id === id);
      if (!item) throw new Error(`inbox item ${id} not found`);
      await vault.undoRoute(id);
      const fresh = await vault.listProjects();
      const r = rulesClassify(item.raw, item.kind, fresh, projectName ?? item.projectHint);
      await vault.routeToProject({
        inboxId: id,
        projectName: r.projectName,
        title: r.title,
        tags: r.tags,
        markdown: r.markdown,
        kind: item.kind
      });
      await vault.setInboxStatus(id, 'ready');
      await refresh();
    },
    [refresh]
  );

  const undoInbox = useCallback(
    async (id: string) => {
      await vault.undoRoute(id);
      await refresh();
    },
    [refresh]
  );

  const value = useMemo<Store>(
    () => ({
      ready,
      error,
      inbox,
      notes,
      projects,
      refresh,
      capture,
      captureDaily,
      routeInbox,
      undoInbox,
      openNote: (id) => vault.getNote(id),
      saveNote: async (id, md) => {
        const d = await vault.saveNote(id, md);
        await refresh();
        return d;
      },
      newNote: async (dir, name) => {
        const id = name?.trim()
          ? await vault.createNamedNoteFile(dir, name.trim())
          : await vault.createNoteFile(dir);
        await refresh();
        return id;
      },
      createDir: async (parentRel, name) => {
        const rel = await vault.createDir(parentRel, name);
        await refresh();
        return rel;
      },
      deleteFile: async (rel) => {
        await vault.trashNoteFile(rel);
        await refresh();
      },
      deleteDir: async (rel) => {
        await vault.trashDir(rel);
        await refresh();
      },
      renameFile: async (oldRel, newName) => {
        const next = await vault.renameNoteFile(oldRel, newName);
        await refresh();
        return next;
      },
      renameDir: async (oldRel, newName) => {
        const next = await vault.renameDir(oldRel, newName);
        await refresh();
        return next;
      },
      appendDaily: captureDaily,
      readDaily: () => vault.readDaily()
    }),
    [ready, error, inbox, notes, projects, refresh, capture, captureDaily, routeInbox, undoInbox]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
