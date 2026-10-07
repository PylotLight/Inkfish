/**
 * Line-based three-way merge (diff3). LCS of base↔ours and base↔theirs gives
 * stable anchors; between anchors, a hunk changed on one side takes that
 * side, identical changes merge, and different changes are a conflict.
 */

/** Index pairs [baseIdx, otherIdx] of a longest common subsequence. */
export function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  // Trim common prefix/suffix first — most edits are local, keeps the DP small.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const n = endA - start, m = endB - start
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < start; i++) pairs.push([i, i])
  if (n > 0 && m > 0) {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i]![j] = a[start + i] === b[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    let i = 0, j = 0
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) { pairs.push([start + i, start + j]); i++; j++ }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
      else j++
    }
  }
  for (let k = 0; endA + k < a.length; k++) pairs.push([endA + k, endB + k])
  return pairs
}

export interface Merge3Result {
  clean: boolean
  /** Merged lines; on conflict, conflicting hunks take `ours`. */
  lines: string[]
  conflicts: number
}

export function merge3(base: string[], ours: string[], theirs: string[]): Merge3Result {
  const mo = new Map(lcsPairs(base, ours))
  const mt = new Map(lcsPairs(base, theirs))
  // Anchors: base lines kept, in order, by both sides.
  const anchors: Array<[number, number, number]> = []
  for (let i = 0; i < base.length; i++) {
    const o = mo.get(i), t = mt.get(i)
    if (o !== undefined && t !== undefined) anchors.push([i, o, t])
  }
  anchors.push([base.length, ours.length, theirs.length])
  const out: string[] = []
  let conflicts = 0
  let pb = 0, po = 0, pt = 0
  const eq = (x: string[], y: string[]): boolean => x.length === y.length && x.every((v, k) => v === y[k])
  for (const [ab, ao, at] of anchors) {
    const b = base.slice(pb, ab), o = ours.slice(po, ao), t = theirs.slice(pt, at)
    if (eq(o, t)) out.push(...o)
    else if (eq(b, o)) out.push(...t)
    else if (eq(b, t)) out.push(...o)
    // Both sides only inserted at the same spot: keep both (ours first).
    // In notes this is the common "added a line on each device" case.
    else if (b.length === 0) out.push(...o, ...t)
    else { conflicts++; out.push(...o) }
    if (ab < base.length) out.push(base[ab]!)
    pb = ab + 1; po = ao + 1; pt = at + 1
  }
  return { clean: conflicts === 0, lines: out, conflicts }
}

export function mergeText(base: string, ours: string, theirs: string): { clean: boolean; text: string; conflicts: number } {
  const r = merge3(base.split('\n'), ours.split('\n'), theirs.split('\n'))
  return { clean: r.clean, text: r.lines.join('\n'), conflicts: r.conflicts }
}
