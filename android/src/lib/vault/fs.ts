import * as FileSystem from 'expo-file-system/legacy'
import { slugToId, type Project } from '../format'
import { VAULT } from './state'
import { readText, RESERVED, SKIP_STAT } from './paths'

export async function childDirs(dir: string): Promise<string[]> {
  try {
    const names = (await FileSystem.readDirectoryAsync(dir)).filter(
      (n) => !n.startsWith('.') && !SKIP_STAT.test(n) && !n.endsWith('.md')
    )
    const hits = await mapLimit(names, 8, async (n) => {
      const info = await FileSystem.getInfoAsync(`${dir}${n}`)
      return info.exists && info.isDirectory
    })
    return names.filter((_, i) => hits[i]).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export async function childFiles(dir: string): Promise<string[]> {
  try {
    const names = (await FileSystem.readDirectoryAsync(dir)).filter((n) => !n.startsWith('.') && n.endsWith('.md'))
    const hits = await mapLimit(names, 8, async (n) => {
      const info = await FileSystem.getInfoAsync(`${dir}${n}`)
      return info.exists && !info.isDirectory
    })
    return names.filter((_, i) => hits[i]).sort()
  } catch {
    return []
  }
}

// --- case-duplicate healing ------------------------------------------------------
// `Personal` vs `personal`: one dir on case-insensitive APFS, two on
// case-sensitive Android/Linux. Fold is plain lowercase — identical to Mac's
// `foldName` — so both sides converge on the same survivor.

export function foldName(s: string): string {
  return s.toLowerCase()
}

function pickSurvivor(names: string[]): string {
  return names.find((n) => n === foldName(n)) ?? [...names].sort()[0]!
}

/** Direct child dir matching `name` case-insensitively (on-disk spelling). */
async function childDirNamed(dir: string, name: string, includeHidden = false): Promise<string | null> {
  let names: string[]
  try {
    names = await FileSystem.readDirectoryAsync(dir)
  } catch {
    return null
  }
  const want = foldName(name)
  for (const n of names) {
    if (n === name) return n
    if (!includeHidden && n.startsWith('.')) continue
    if (foldName(n) !== want) continue
    const info = await FileSystem.getInfoAsync(`${dir}${n}`)
    if (info.exists && info.isDirectory) return n
  }
  return null
}

/** Resolve each segment of dirRel to its on-disk spelling (see Mac `resolveDirRel`). */
export async function resolveDirRel(dirRel: string): Promise<string> {
  if (!dirRel) return ''
  const out: string[] = []
  let cur = VAULT
  for (const seg of dirRel.split('/')) {
    if (!seg || seg === '.') continue
    const hit = await childDirNamed(cur, seg)
    const use = hit ?? seg
    out.push(use)
    cur = `${cur}${use}/`
  }
  return out.join('/')
}

/** True when the folder holds nothing but hidden files (or nothing at all). */
async function dirIsEmpty(uri: string): Promise<boolean> {
  try {
    const names = await FileSystem.readDirectoryAsync(uri)
    for (const n of names) {
      if (!n.startsWith('.')) return false
      const info = await FileSystem.getInfoAsync(`${uri}${n}`)
      if (info.exists && info.isDirectory) return false
    }
    return true
  } catch {
    return false
  }
}

async function uniqueName(dir: string, file: string): Promise<string> {
  const dot = file.lastIndexOf('.')
  const base = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  let name = file
  let i = 1
  while ((await FileSystem.getInfoAsync(`${dir}${name}`)).exists) {
    i++
    name = `${base} ${i}${ext}`
  }
  return name
}

async function fileTextEq(a: string, b: string): Promise<boolean> {
  try {
    return (await readText(a)) === (await readText(b))
  } catch {
    return false
  }
}

async function mergeDirInto(srcDir: string, dstDir: string): Promise<number> {
  let files = 0
  let names: string[]
  try {
    names = await FileSystem.readDirectoryAsync(srcDir)
  } catch {
    return 0
  }
  for (const n of names) {
    const from = `${srcDir}${n}`
    const info = await FileSystem.getInfoAsync(from)
    if (!info.exists) continue
    if (info.isDirectory) {
      const hit = await childDirNamed(dstDir, n, true)
      if (hit) {
        files += await mergeDirInto(`${from}/`, `${dstDir}${hit}/`)
        await FileSystem.deleteAsync(from, { idempotent: true })
      } else {
        await FileSystem.moveAsync({ from, to: `${dstDir}${n}` })
      }
      continue
    }
    if (!info.isDirectory && !n.endsWith('.md')) {
      // Non-note files ride along; bump on any collision so nothing is lost.
      if (!(await FileSystem.getInfoAsync(`${dstDir}${n}`)).exists) {
        await FileSystem.moveAsync({ from, to: `${dstDir}${n}` })
      } else {
        const bumped = await uniqueName(dstDir, n)
        await FileSystem.moveAsync({ from, to: `${dstDir}${bumped}` })
      }
      continue
    }
    let onto: string | null = null
    if ((await FileSystem.getInfoAsync(`${dstDir}${n}`)).exists) onto = n
    else {
      // Case-variant of an existing note?
      let kids: string[]
      try {
        kids = await FileSystem.readDirectoryAsync(dstDir)
      } catch {
        kids = []
      }
      for (const k of kids) {
        if (k === n || foldName(k) !== foldName(n)) continue
        const ki = await FileSystem.getInfoAsync(`${dstDir}${k}`)
        if (ki.exists && !ki.isDirectory) {
          onto = k
          break
        }
      }
    }
    if (!onto) {
      await FileSystem.moveAsync({ from, to: `${dstDir}${n}` })
      files++
    } else if (await fileTextEq(from, `${dstDir}${onto}`)) {
      await FileSystem.deleteAsync(from, { idempotent: true })
    } else {
      const bumped = await uniqueName(dstDir, n)
      await FileSystem.moveAsync({ from, to: `${dstDir}${bumped}` })
      files++
    }
  }
  return files
}

export interface CaseMergeReport {
  dirs: number
  files: number
}

/** Collapse sibling dirs/notes that differ only by case, recursively.
 * Same survivor rule as Mac — both sides always agree. Reserved top-level
 * names are skipped. */
export async function mergeCaseDuplicates(): Promise<CaseMergeReport> {
  const report: CaseMergeReport = { dirs: 0, files: 0 }
  const heal = async (dir: string, top: boolean): Promise<void> => {
    let names: string[]
    try {
      names = await FileSystem.readDirectoryAsync(dir)
    } catch {
      return
    }
    const dirGroups = new Map<string, string[]>()
    const fileGroups = new Map<string, string[]>()
    for (const n of names) {
      if (n.startsWith('.')) continue
      const info = await FileSystem.getInfoAsync(`${dir}${n}`)
      if (!info.exists) continue
      const key = foldName(n)
      if (info.isDirectory) {
        if (top && RESERVED.has(key)) continue
        const arr = dirGroups.get(key) ?? []
        arr.push(n)
        dirGroups.set(key, arr)
      } else if (n.endsWith('.md')) {
        const arr = fileGroups.get(key) ?? []
        arr.push(n)
        fileGroups.set(key, arr)
      }
    }
    for (const [key, all] of dirGroups) {
      if (all.length < 2) continue
      // An empty spelling (a seeded `work/`, or one sync just emptied by
      // adopting the Mac's `Work/`) is dropped, never chosen as the survivor —
      // otherwise the heal fights the Mac's spelling and sync loops.
      const group: string[] = []
      for (const n of all) {
        if (await dirIsEmpty(`${dir}${n}/`)) await FileSystem.deleteAsync(`${dir}${n}`, { idempotent: true })
        else group.push(n)
      }
      if (group.length < 2) continue
      const survivor = pickSurvivor(group)
      if (survivor !== key) await FileSystem.moveAsync({ from: `${dir}${survivor}`, to: `${dir}${key}` })
      for (const loser of group) {
        if (loser === survivor) continue
        report.files += await mergeDirInto(`${dir}${loser}/`, `${dir}${key}/`)
        await FileSystem.deleteAsync(`${dir}${loser}`, { idempotent: true })
      }
      report.dirs++
    }
    for (const [key, group] of fileGroups) {
      if (group.length < 2) continue
      const survivor = pickSurvivor(group)
      if (survivor !== key) await FileSystem.moveAsync({ from: `${dir}${survivor}`, to: `${dir}${key}` })
      for (const loser of group) {
        if (loser === survivor) continue
        const from = `${dir}${loser}`
        const onto = `${dir}${key}`
        if (await fileTextEq(from, onto)) {
          await FileSystem.deleteAsync(from, { idempotent: true })
        } else {
          const bumped = await uniqueName(dir, loser)
          await FileSystem.moveAsync({ from, to: `${dir}${bumped}` })
          report.files++
        }
      }
    }
    let next: string[]
    try {
      next = await FileSystem.readDirectoryAsync(dir)
    } catch {
      return
    }
    for (const n of next) {
      if (n.startsWith('.')) continue
      const info = await FileSystem.getInfoAsync(`${dir}${n}`)
      if (info.exists && info.isDirectory) await heal(`${dir}${n}/`, false)
    }
  }
  await heal(VAULT, true)
  return report
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

export function hasCaseDupes(names: readonly string[]): boolean {
  const seen = new Set<string>()
  for (const n of names) {
    const k = foldName(n)
    if (seen.has(k)) return true
    seen.add(k)
  }
  return false
}

const COLORS = ['#6ea8fe', '#7ee2a8', '#e5a56e', '#c79bfe', '#e5636f', '#6ed3e5']

export function projectsFromNames(names: string[]): Project[] {
  const seen = new Set<string>()
  const found: Project[] = []
  for (const name of names) {
    if (RESERVED.has(name.toLowerCase())) continue
    const id = slugToId(name)
    if (seen.has(id)) continue
    seen.add(id)
    found.push({ id, name, dir: name })
  }
  return found
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (project, index) =>
        ({
          ...project,
          color: COLORS[index % COLORS.length]
        }) as Project
    )
}

/** Display name for a sidebar row — the filename, never content. */
export function fileLabel(vaultRel: string): string {
  const base = vaultRel.split('/').pop() ?? vaultRel
  return base.replace(/\.md$/i, '')
}
