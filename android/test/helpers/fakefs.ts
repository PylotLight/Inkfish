/**
 * In-memory stand-in for `expo-file-system/legacy` with simulated per-call
 * bridge latency, for startup benchmarks and tests. Same cost model as
 * scripts/bench-sync.ts (#83): every call pays a native cost; a few calls can
 * be in flight at once (expo runs async functions on a small native pool) but
 * each one also pays a short serial JS↔native hop.
 *
 * Install with `mock.module('expo-file-system/legacy', () => fs.module)`
 * BEFORE importing anything that imports the file system.
 */

export const COST = {
  /** serial JS→native hop every call pays, ms */
  hop: 0.25,
  stat: 1.5,
  readDir: 2,
  ioBase: 1.2,
  /** utf8/base64 over the bridge, MB/s */
  ioMBs: 40,
  write: 2,
  /** native calls that can overlap */
  lanes: 4
};

export interface Counts {
  stat: number;
  readDir: number;
  read: number;
  write: number;
  other: number;
}

const sleep = (ms: number): Promise<void> => (ms > 0.02 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export class FakeFs {
  readonly root = 'file:///data/user/0/com.pylotlight.inkfish/files/';
  files = new Map<string, { text: string; size: number; mtime: number }>();
  dirs = new Set<string>();
  counts: Counts = { stat: 0, readDir: 0, read: 0, write: 0, other: 0 };
  /** 0 = no sleeps (counts only). */
  scale = 1;
  private hopChain: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private clock = 1_700_000_000;

  constructor() {
    this.dirs.add(this.trim(this.root));
  }

  resetCounts(): void {
    this.counts = { stat: 0, readDir: 0, read: 0, write: 0, other: 0 };
  }
  total(): number {
    const c = this.counts;
    return c.stat + c.readDir + c.read + c.write + c.other;
  }

  private trim(uri: string): string {
    return uri.endsWith('/') ? uri.slice(0, -1) : uri;
  }
  private addParents(uri: string): void {
    let p = this.trim(uri);
    while (p.length > this.trim(this.root).length) {
      p = p.slice(0, p.lastIndexOf('/'));
      this.dirs.add(p);
    }
  }

  /** Seed a file without paying latency. */
  put(uri: string, text: string, size = text.length, mtime?: number): void {
    this.addParents(uri);
    this.files.set(this.trim(uri), { text, size, mtime: mtime ?? this.clock++ });
  }

  private async cost(ms: number): Promise<void> {
    if (!this.scale) return;
    const hop = this.hopChain.then(() => sleep(COST.hop * this.scale));
    this.hopChain = hop;
    await hop;
    if (this.inFlight >= COST.lanes) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
    try {
      await sleep(ms * this.scale);
    } finally {
      this.inFlight--;
      this.waiters.shift()?.();
    }
  }

  private children(dir: string): string[] {
    const pre = `${this.trim(dir)}/`;
    const out = new Set<string>();
    for (const p of this.files.keys()) if (p.startsWith(pre)) out.add(p.slice(pre.length).split('/')[0]!);
    for (const p of this.dirs) if (p.startsWith(pre)) out.add(p.slice(pre.length).split('/')[0]!);
    return [...out];
  }

  readonly module = {
    documentDirectory: this.root,
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    getInfoAsync: async (uri: string) => {
      this.counts.stat++;
      await this.cost(COST.stat);
      const k = this.trim(uri);
      const f = this.files.get(k);
      if (f) return { exists: true, isDirectory: false, size: f.size, modificationTime: f.mtime, uri };
      if (this.dirs.has(k)) return { exists: true, isDirectory: true, size: 0, modificationTime: 0, uri };
      return { exists: false, isDirectory: false, uri };
    },
    readDirectoryAsync: async (uri: string) => {
      this.counts.readDir++;
      await this.cost(COST.readDir);
      if (!this.dirs.has(this.trim(uri))) throw new Error(`not a dir: ${uri}`);
      return this.children(uri);
    },
    readAsStringAsync: async (uri: string) => {
      this.counts.read++;
      const f = this.files.get(this.trim(uri));
      await this.cost(COST.ioBase + (f?.size ?? 0) / (COST.ioMBs * 1024));
      if (!f) throw new Error(`no such file: ${uri}`);
      return f.text;
    },
    writeAsStringAsync: async (uri: string, text: string) => {
      this.counts.write++;
      await this.cost(COST.write + text.length / (COST.ioMBs * 1024));
      const k = this.trim(uri);
      if (!this.dirs.has(k.slice(0, k.lastIndexOf('/')))) throw new Error(`no parent: ${uri}`);
      this.files.set(k, { text, size: text.length, mtime: this.clock++ });
    },
    makeDirectoryAsync: async (uri: string) => {
      this.counts.other++;
      await this.cost(COST.write);
      this.addParents(uri);
      this.dirs.add(this.trim(uri));
    },
    deleteAsync: async (uri: string) => {
      this.counts.other++;
      await this.cost(COST.write);
      const k = this.trim(uri);
      this.files.delete(k);
      for (const p of [...this.files.keys()]) if (p.startsWith(`${k}/`)) this.files.delete(p);
      for (const p of [...this.dirs]) if (p === k || p.startsWith(`${k}/`)) this.dirs.delete(p);
    },
    moveAsync: async ({ from, to }: { from: string; to: string }) => {
      this.counts.other++;
      await this.cost(COST.write);
      const a = this.trim(from);
      const b = this.trim(to);
      this.addParents(b);
      const f = this.files.get(a);
      if (f) {
        this.files.delete(a);
        this.files.set(b, f);
        return;
      }
      for (const [p, v] of [...this.files]) {
        if (p.startsWith(`${a}/`)) {
          this.files.delete(p);
          this.files.set(b + p.slice(a.length), v);
        }
      }
      for (const p of [...this.dirs]) {
        if (p === a || p.startsWith(`${a}/`)) {
          this.dirs.delete(p);
          this.dirs.add(b + p.slice(a.length));
        }
      }
    },
    copyAsync: async ({ from, to }: { from: string; to: string }) => {
      this.counts.other++;
      await this.cost(COST.write);
      const f = this.files.get(this.trim(from));
      if (f) {
        this.addParents(to);
        this.files.set(this.trim(to), { ...f, mtime: this.clock++ });
      }
    }
  };
}

/** Deterministic PRNG so every run builds the same vault. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface SeedOpts {
  notes: number;
  images: number;
  inbox?: number;
  daily?: number;
}

/**
 * A vault shaped like a real one: ~1-2k notes across nested project folders,
 * a few large ones, images under assets/YYYY/MM, some inbox + daily files.
 * Returns the vault-relative note paths and the ids of a sample of notes.
 */
export function seedVault(fs: FakeFs, o: SeedOpts): { rels: string[]; ids: string[] } {
  const r = rng(42);
  const vault = `${fs.root}inkfish/vault/`;
  const staging = `${fs.root}inkfish/staging/`;
  const projects = ['personal', 'work', 'reading', 'recipes', 'travel', 'journal', 'dev', 'ideas', 'health', 'finance'];
  const rels: string[] = [];
  const ids: string[] = [];
  const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore. ';
  for (let i = 0; i < o.notes; i++) {
    const p = projects[i % projects.length]!;
    const sub = r() < 0.6 ? `/${p}-${Math.floor(r() * 6)}` : '';
    const name = `${2024 + (i % 3)}-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}-note-${i}.md`;
    const rel = `${p}${sub}/${name}`;
    const big = r() < 0.05;
    const body = filler.repeat(big ? 200 : 8 + Math.floor(r() * 30));
    const withId = r() < 0.7;
    const id = withId ? `n_${i.toString(36)}` : rel;
    const fm = withId ? `---\nid: ${id}\nkind: text\ncreated: 2025-01-01T00:00:00.000Z\ntags: [a, b]\n---\n` : '';
    const img = i % 25 === 0 && o.images > 0 ? `\n![](assets/2025/0${1 + (i % 9)}/img-${i % o.images}.png)\n` : '';
    fs.put(`${vault}${rel}`, `${fm}# Note ${i}\n\n${body}${img}\n`);
    rels.push(rel);
    if (i % 97 === 0) ids.push(id);
  }
  for (let i = 0; i < o.images; i++) {
    // images are never read by the index; only their size matters for listing
    fs.put(`${vault}assets/2025/0${1 + (i % 9)}/img-${i}.png`, '', 150_000 + Math.floor(r() * 400_000));
  }
  for (let i = 0; i < (o.inbox ?? 15); i++) {
    fs.put(
      `${staging}inbox/in_${i}.md`,
      `---\nid: in_${i}\nkind: text\nstatus: ready\ncreated: 2025-01-0${1 + (i % 9)}T00:00:00.000Z\nsource: android\nprojectHint: auto\nassets: []\n---\ncapture ${i}\n`
    );
  }
  for (let i = 0; i < (o.daily ?? 30); i++) {
    fs.put(`${staging}daily/2025-09-${String(1 + i).padStart(2, '0')}.md`, `---\nkind: daily\n---\n# day ${i}\n\n## 09:00\n\nstuff\n`);
  }
  fs.dirs.add(`${fs.root}inkfish/staging/undone`);
  return { rels, ids };
}
