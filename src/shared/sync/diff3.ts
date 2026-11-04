/**
 * Line-based three-way merge (diff3). Each side is reduced to edit hunks against
 * the base, then the hunks are reconciled by their base-line ranges. Comparing
 * the edits themselves (rather than only lines kept by both sides) lets
 * independent changes on adjacent lines merge without manufacturing a conflict.
 */

/** Index pairs [baseIdx, otherIdx] of a longest common subsequence. */
export function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  // Trim common prefix/suffix first — most edits are local, keeps the DP small.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length,
    endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start,
    m = endB - start
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < start; i++) pairs.push([i, i])
  if (n > 0 && m > 0) {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i]![j] = a[start + i] === b[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    let i = 0,
      j = 0
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j])
        i++
        j++
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
      else j++
    }
  }
  for (let k = 0; endA + k < a.length; k++) pairs.push([endA + k, endB + k])
  return pairs
}

interface Edit {
  /** Inclusive start, exclusive end in the base; start === end means insertion. */
  start: number
  end: number
  lines: string[]
}

function editsFrom(base: string[], other: string[]): Edit[] {
  const matches: Array<[number, number]> = [[-1, -1], ...lcsPairs(base, other), [base.length, other.length]]
  const edits: Edit[] = []
  for (let i = 1; i < matches.length; i++) {
    const [prevBase, prevOther] = matches[i - 1]!
    const [nextBase, nextOther] = matches[i]!
    const start = prevBase + 1
    const end = nextBase
    const lines = other.slice(prevOther + 1, nextOther)
    if (start !== end || lines.length) edits.push({ start, end, lines })
  }
  return edits
}

function overlaps(a: Edit, b: Edit): boolean {
  const aInsert = a.start === a.end
  const bInsert = b.start === b.end
  if (aInsert && bInsert) return a.start === b.start
  if (aInsert) return b.start < a.start && a.start < b.end
  if (bInsert) return a.start < b.start && b.start < a.end
  return a.start < b.end && b.start < a.end
}

function touchesRegion(edit: Edit, start: number, end: number): boolean {
  if (edit.start === edit.end) return start < edit.start && edit.start < end
  return edit.start < end && start < edit.end
}

function applyEdits(base: string[], start: number, end: number, edits: Edit[]): string[] {
  const out: string[] = []
  let cursor = start
  for (const edit of edits) {
    out.push(...base.slice(cursor, edit.start), ...edit.lines)
    cursor = edit.end
  }
  out.push(...base.slice(cursor, end))
  return out
}

export interface Merge3Result {
  clean: boolean
  /** Merged lines; on conflict, conflicting hunks take `ours`. */
  lines: string[]
  conflicts: number
}

export function merge3(base: string[], ours: string[], theirs: string[]): Merge3Result {
  const oursEdits = editsFrom(base, ours)
  const theirsEdits = editsFrom(base, theirs)
  const out: string[] = []
  let conflicts = 0
  let oi = 0,
    ti = 0,
    cursor = 0
  const equal = (a: string[], b: string[]): boolean => a.length === b.length && a.every((line, i) => line === b[i])

  while (oi < oursEdits.length || ti < theirsEdits.length) {
    const o = oursEdits[oi]
    const t = theirsEdits[ti]

    // Concurrent inserts at the exact same point retain both, in stable order.
    if (o && t && o.start === o.end && t.start === t.end && o.start === t.start) {
      out.push(...base.slice(cursor, o.start), ...o.lines, ...(equal(o.lines, t.lines) ? [] : t.lines))
      cursor = o.start
      oi++
      ti++
      continue
    }

    if (o && t && overlaps(o, t)) {
      // Grow a connected overlap cluster. This also handles one broad edit
      // colliding with multiple narrower edits from the other side.
      let start = Math.min(o.start, t.start)
      let end = Math.max(o.end, t.end)
      const groupO = [o]
      const groupT = [t]
      oi++
      ti++
      let grew = true
      while (grew) {
        grew = false
        while (oursEdits[oi] && touchesRegion(oursEdits[oi]!, start, end)) {
          const edit = oursEdits[oi++]!
          groupO.push(edit)
          start = Math.min(start, edit.start)
          end = Math.max(end, edit.end)
          grew = true
        }
        while (theirsEdits[ti] && touchesRegion(theirsEdits[ti]!, start, end)) {
          const edit = theirsEdits[ti++]!
          groupT.push(edit)
          start = Math.min(start, edit.start)
          end = Math.max(end, edit.end)
          grew = true
        }
      }
      out.push(...base.slice(cursor, start))
      const basePart = base.slice(start, end)
      const oursPart = applyEdits(base, start, end, groupO)
      const theirsPart = applyEdits(base, start, end, groupT)
      if (equal(oursPart, theirsPart)) out.push(...oursPart)
      else if (equal(oursPart, basePart)) out.push(...theirsPart)
      else if (equal(theirsPart, basePart)) out.push(...oursPart)
      else {
        conflicts++
        out.push(...oursPart)
      }
      cursor = end
      continue
    }

    // No overlap: apply the earlier hunk. At the same start, an insertion is
    // before a replacement of that line, so both independent edits survive.
    const takeOurs =
      !!o &&
      (!t ||
        o.start < t.start ||
        (o.start === t.start && o.start === o.end && t.start !== t.end) ||
        (o.start === t.start && o.end < t.end))
    const edit = takeOurs ? o! : t!
    out.push(...base.slice(cursor, edit.start), ...edit.lines)
    cursor = edit.end
    if (takeOurs) oi++
    else ti++
  }

  out.push(...base.slice(cursor))
  return { clean: conflicts === 0, lines: out, conflicts }
}

export function mergeText(
  base: string,
  ours: string,
  theirs: string
): { clean: boolean; text: string; conflicts: number } {
  const r = merge3(base.split('\n'), ours.split('\n'), theirs.split('\n'))
  return { clean: r.clean, text: r.lines.join('\n'), conflicts: r.conflicts }
}
