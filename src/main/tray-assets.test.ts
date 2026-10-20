import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// tray.ts loads assets/trayTemplate(@2x).png / tray.png at runtime. electron-builder only
// packs what build.files lists, so a missing glob ships the 1x1 transparent fallback (blank tray).
const root = join(import.meta.dir, '../..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const files: string[] = pkg.build.files

const globToRe = (g: string): RegExp =>
  new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(.*/)?').replace(/\*/g, '[^/]*') + '$')

describe('tray icon assets get packaged', () => {
  for (const f of ['assets/trayTemplate.png', 'assets/trayTemplate@2x.png', 'assets/tray.png']) {
    test(f, () => {
      expect(existsSync(join(root, f))).toBe(true)
      expect(files.some((g) => globToRe(g).test(f))).toBe(true)
    })
  }
})
