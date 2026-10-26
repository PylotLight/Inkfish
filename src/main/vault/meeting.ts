import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { MeetingSaveInput } from '../../shared/types'
import { ensureVault } from './bootstrap'
import { assertInside, uniqueFile } from './fs'
import { stringifyFrontmatter } from './frontmatter'
import { vaultPaths } from './paths'
import type { VaultPaths } from './types'

// --- live meeting notes ---------------------------------------------------------

const fmtDuration = (sec: number): string => {
  const m = Math.round(sec / 60)
  return m < 1 ? `${Math.round(sec)}s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * Write a captured meeting as its own note: `<vault>/<folder>/YYYY-MM-DD HHmm Title.md`
 * with `kind: meeting`. Re-saving with `replaceRel` re-titles / re-files it.
 */
export function writeMeetingNote(input: MeetingSaveInput, paths: VaultPaths = vaultPaths()): string {
  ensureVault(paths)
  const folder = input.folder.trim().replace(/^\/+|\/+$/g, '')
  const dir = join(paths.root, folder)
  if (folder) assertInside(paths.root, dir, folder)
  mkdirSync(dir, { recursive: true })
  const started = new Date(input.startedAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`
  const title = input.title.trim() || 'Meeting'
  const base = `${day} ${pad(started.getHours())}${pad(started.getMinutes())} ${title.replace(/[/\\:]+/g, '-')}`.slice(
    0,
    110
  )
  const prev = input.replaceRel ? join(paths.root, input.replaceRel) : null
  if (prev) assertInside(paths.root, prev, input.replaceRel as string)
  const name =
    prev && dirname(prev) === dir && basename(prev) === `${base}.md` ? `${base}.md` : uniqueFile(dir, base, '.md')
  const abs = join(dir, name)
  const fm = stringifyFrontmatter({
    kind: 'meeting',
    created: started.toISOString(),
    duration: fmtDuration(input.durationSec),
    speakers: input.speakers,
    tags: input.tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
  })
  const when = started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const audio = input.audioRel ? `\n![](${input.audioRel})\n` : ''
  const body =
    `# ${title}\n\n> ${when} · ${fmtDuration(input.durationSec)} · ${input.speakers.join(', ')}\n${audio}\n` +
    `## Notes\n\n- \n\n## Actions\n\n- [ ] \n\n## Transcript\n\n${input.transcript.trim() || '_Nothing was transcribed._'}\n`
  writeFileSync(abs, `${fm}${body}`, 'utf8')
  if (prev && prev !== abs && existsSync(prev)) unlinkSync(prev)
  return relative(paths.root, abs)
}

// --- meeting import --------------------------------------------------------------

/** Parse a Teams-exported `.vtt` (or plain transcript) into timestamped lines. */
export function parseVtt(text: string): Array<{ at: string; speaker: string; line: string }> {
  const out: Array<{ at: string; speaker: string; line: string }> = []
  // Drop WEBVTT header + NOTE blocks, then cue blocks.
  const body = text
    .replace(/^WEBVTT.*$/m, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
  for (const block of body) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length === 0) continue
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    const first = lines[0] ?? ''
    const at = timeIdx >= 0 ? ((lines[timeIdx] ?? '').split('-->')[0]?.trim() ?? '') : ''
    const content = (timeIdx >= 0 ? lines.slice(timeIdx + 1) : lines).join(' ')
    if (!content || /^NOTE/i.test(first)) continue
    const m = /^<v\s+([^>]+)>(.*)<\/v>\s*$/i.exec(content) ?? /^([^:]{1,40}):\s+(.*)$/.exec(content)
    out.push({
      at,
      speaker: m ? (m[1]?.trim() ?? '') : '',
      line: m ? (m[2] ?? '').trim() : content
    })
  }
  return out
}

export function meetingToMarkdown(cues: Array<{ at: string; speaker: string; line: string }>, title: string): string {
  const attendees = [...new Set(cues.map((c) => c.speaker).filter(Boolean))]
  const transcript = cues
    .map((c) => `- ${c.at ? `**${c.at}** ` : ''}${c.speaker ? `**${c.speaker}:** ` : ''}${c.line}`)
    .join('\n')
  return (
    `> ${title} — captured transcript. Fill in decisions + actions below.\n\n` +
    `## Attendees\n\n${attendees.length > 0 ? attendees.map((a) => `- ${a}`).join('\n') : '- '}\n\n` +
    `## Decisions\n\n- \n\n## Actions\n\n- [ ] \n\n## Transcript\n\n${transcript || '- '}\n`
  )
}
