import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { uniqueName } from '../../shared/note-move'
import { assertInside, childDirNamed, foldName, resolveDirRel, uniqueFile } from './fs'
import { vaultPaths } from './paths'
import { RESERVED_DIRS } from './projects'
import type { CaseMergeReport, MoveOptions, VaultPaths } from './types'

/** New `Untitled.md` (numbered) in dirRel ('' = vault root). Returns vaultRel. */
export function createNoteFile(dirRel: string, paths: VaultPaths = vaultPaths()): string {
  const resolved = resolveDirRel(dirRel, paths)
  const dir = join(paths.root, resolved)
  assertInside(paths.root, join(paths.root, `${resolved}/x`), `folder ${resolved || '/'}`)
  mkdirSync(dir, { recursive: true })
  const name = uniqueFile(dir, 'Untitled', '.md')
  const abs = join(dir, name)
  writeFileSync(abs, '', 'utf8')
  return relative(paths.root, abs)
}

/** New subfolder. Returns vaultRel. Never forks a case-variant sibling
 * (`Personal` when `personal` exists) — it reuses the existing dir. */
export function createDir(parentRel: string, name: string, paths: VaultPaths = vaultPaths()): string {
  const clean = name
    .trim()
    .replace(/[/\\]+/g, '-')
    .slice(0, 80)
  if (!clean) throw new Error('folder name is empty')
  const parent = resolveDirRel(parentRel, paths)
  const parentAbs = join(paths.root, parent)
  assertInside(paths.root, join(parentAbs, 'x'), `folder ${parent || '/'}`)
  const existing = childDirNamed(parentAbs, clean)
  if (existing) return relative(paths.root, join(parentAbs, existing))
  const abs = join(parentAbs, clean)
  assertInside(paths.root, abs, `folder ${clean}`)
  mkdirSync(abs, { recursive: true })
  return relative(paths.root, abs)
}

/** Rename a file (keeps ext unless newName has one) or dir. Returns new vaultRel. */
export function renamePath(rel: string, newName: string, paths: VaultPaths = vaultPaths()): string {
  const clean = newName
    .trim()
    .replace(/[/\\]+/g, '-')
    .slice(0, 120)
  if (!clean) throw new Error('name is empty')
  const abs = join(paths.root, rel)
  assertInside(paths.root, abs, rel)
  const st = statSync(abs)
  const target = st.isDirectory() ? clean : extname(clean) ? clean : `${clean}.md`
  const dest = join(dirname(abs), target)
  assertInside(paths.root, dest, target)
  if (existsSync(dest)) {
    // A case-only change (`japan` → `Japan`, easy now with inline rename) on a case-insensitive
    // disk (APFS default) finds the file itself under the new spelling: a rename, not a collision.
    const d = statSync(dest)
    const caseOnly = basename(dest) !== basename(abs) && basename(dest).toLowerCase() === basename(abs).toLowerCase()
    if (!(caseOnly && d.ino === st.ino && d.dev === st.dev)) throw new Error(`${target} already exists`)
  }
  renameSync(abs, dest)
  return relative(paths.root, dest)
}

/** Move a file or dir into another folder ('' = root). Returns new vaultRel. */
export function movePath(
  rel: string,
  destDirRel: string,
  paths: VaultPaths = vaultPaths(),
  opts: MoveOptions = {}
): string {
  const abs = join(paths.root, rel)
  assertInside(paths.root, abs, rel)
  if (!existsSync(abs)) throw new Error(`${rel} not found`)
  const resolved = resolveDirRel(destDirRel, paths)
  const destDir = join(paths.root, resolved)
  if (resolved) assertInside(paths.root, destDir, resolved)
  if (destDir === abs || destDir.startsWith(`${abs}/`)) throw new Error('cannot move a folder into itself')
  if (dirname(abs) === destDir) return rel
  mkdirSync(destDir, { recursive: true })
  let name = basename(abs)
  // Case-insensitive like APFS, so Linux/Android never end up with `Note.md` + `note.md`.
  const taken = new Set(readdirSync(destDir).map(foldName))
  if (taken.has(foldName(name))) {
    if (opts.onConflict !== 'rename') throw new Error(`${name} already exists in ${resolved || '/'}`)
    name = uniqueName(name, (n) => taken.has(foldName(n)), statSync(abs).isDirectory())
  }
  const dest = join(destDir, name)
  renameSync(abs, dest)
  return relative(paths.root, dest)
}

// --- case-duplicate healing ------------------------------------------------------
// `Personal` vs `personal`: one dir on case-insensitive APFS, two on
// case-sensitive Android/Linux — sync then fights itself and each side shows
// a different tree. Folding is by plain lowercase on both platforms so the
// merge converges to the same survivor everywhere.

/** Survivor for a case-duplicate group: the already-lowercase member when
 * there is one, else the code-unit-smallest (deterministic everywhere). */
function pickSurvivor(names: string[]): string {
  return names.find((n) => n === foldName(n)) ?? [...names].sort()[0]!
}

function sameBytes(a: string, b: string): boolean {
  try {
    const [x, y] = [readFileSync(a), readFileSync(b)]
    return x.length === y.length && x.equals(y)
  } catch {
    return false
  }
}

/** Move everything from srcDir into dstDir, folding nested case collisions
 * the same way (identical files dedupe, the rest bump to `name 2.md`).
 * Dot entries ride along so the loser vanishes completely. */
function mergeDirInto(srcDir: string, dstDir: string): { files: number } {
  let files = 0
  let entries: Dirent<string>[]
  try {
    entries = readdirSync(srcDir, { withFileTypes: true })
  } catch {
    return { files }
  }
  for (const e of entries) {
    const from = join(srcDir, e.name)
    if (e.isDirectory()) {
      const hit = childDirNamed(dstDir, e.name, true)
      if (hit) {
        files += mergeDirInto(from, join(dstDir, hit)).files
        try {
          rmSync(from, { recursive: true, force: true })
        } catch {
          // keep going
        }
      } else {
        renameSync(from, join(dstDir, e.name))
      }
      continue
    }
    if (!e.isFile()) continue
    const dest = join(dstDir, e.name)
    const hit = existsSync(dest)
      ? e.name
      : ((): string | null => {
          // Case-variant of an existing file?
          let kids: Dirent<string>[]
          try {
            kids = readdirSync(dstDir, { withFileTypes: true })
          } catch {
            return null
          }
          return (
            kids.find((k) => k.isFile() && k.name !== e.name && foldName(k.name) === foldName(e.name))?.name ?? null
          )
        })()
    if (!hit) {
      renameSync(from, dest)
      files++
    } else if (sameBytes(from, join(dstDir, hit))) {
      unlinkSync(from)
    } else {
      const dot = e.name.lastIndexOf('.')
      const base = dot > 0 ? e.name.slice(0, dot) : e.name
      const ext = dot > 0 ? e.name.slice(dot) : ''
      renameSync(from, join(dstDir, uniqueFile(dstDir, base, ext)))
      files++
    }
  }
  return { files }
}

/** Collapse sibling dirs/files that differ only by case, recursively.
 * Survivor spelling is the lowercase fold (or the already-lowercase member),
 * so macOS and Android always agree. Reserved top-level names are skipped.
 * Returns what moved. */
export function mergeCaseDuplicates(root: string): CaseMergeReport {
  const report: CaseMergeReport = { dirs: 0, files: 0 }
  const heal = (dir: string, top: boolean): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirGroups = new Map<string, string[]>()
    const fileGroups = new Map<string, string[]>()
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const key = foldName(e.name)
      if (e.isDirectory()) {
        if (top && RESERVED_DIRS.has(key)) continue
        const arr = dirGroups.get(key) ?? []
        arr.push(e.name)
        dirGroups.set(key, arr)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const arr = fileGroups.get(key) ?? []
        arr.push(e.name)
        fileGroups.set(key, arr)
      }
    }
    for (const [key, names] of dirGroups) {
      if (names.length > 1) {
        const survivor = pickSurvivor(names)
        if (survivor !== key) renameSync(join(dir, survivor), join(dir, key))
        for (const loser of names) {
          if (loser === survivor) continue
          report.files += mergeDirInto(join(dir, loser), join(dir, key)).files
          try {
            rmSync(join(dir, loser), { recursive: true, force: true })
          } catch {
            // keep going
          }
        }
        report.dirs++
      }
    }
    for (const [key, names] of fileGroups) {
      if (names.length < 2) continue
      const survivor = pickSurvivor(names)
      if (survivor !== key) renameSync(join(dir, survivor), join(dir, key))
      for (const loser of names) {
        if (loser === survivor) continue
        const from = join(dir, loser)
        const onto = join(dir, key)
        if (sameBytes(from, onto)) {
          unlinkSync(from)
        } else {
          const dot = loser.lastIndexOf('.')
          const base = dot > 0 ? loser.slice(0, dot) : loser
          const ext = dot > 0 ? loser.slice(dot) : ''
          renameSync(from, join(dir, uniqueFile(dir, base, ext)))
          report.files++
        }
      }
    }
    // Recurse into the surviving layout.
    let next: Dirent<string>[]
    try {
      next = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of next) {
      if (e.isDirectory() && !e.name.startsWith('.')) heal(join(dir, e.name), false)
    }
  }
  heal(root, true)
  return report
}
