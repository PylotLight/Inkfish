// Derives the app icon (build/icon.png + build/icon.icns) from the master logo
// at assets/Inkfish_logo.png — zero dependencies.
// Run with: bun scripts/make-app-icon.ts  (or: bun run icon)
//
// The .icns is hand-assembled: PNG-compressed entries (icp4..ic10), which
// macOS accepts. electron-builder needs a prebuilt .icns on non-mac hosts
// (no iconutil there), so both files are committed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resampleRgba } from './lib/png'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
mkdirSync(buildDir, { recursive: true })

const master = decodePng(new Uint8Array(readFileSync(join(root, 'assets', 'Inkfish_logo.png'))))
console.log(`[icon] master ${master.width}×${master.height}`)

function at(size: number): Buffer {
  return encodePng(size, size, resampleRgba(master.data, master.width, master.height, size, size))
}

function icns(pngs: Array<{ type: string; png: Buffer }>): Buffer {
  const entries = pngs.map(({ type, png }) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(8 + png.length, 0)
    return Buffer.concat([Buffer.from(type, 'ascii'), len, png])
  })
  const body = Buffer.concat(entries)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

writeFileSync(join(buildDir, 'icon.png'), at(1024))
console.log('[icon] wrote build/icon.png (1024×1024, from Inkfish_logo.png)')

const sizes: Array<{ px: number; type: string }> = [
  { px: 16, type: 'icp4' },
  { px: 32, type: 'icp5' },
  { px: 64, type: 'icp6' },
  { px: 128, type: 'ic07' },
  { px: 256, type: 'ic08' },
  { px: 512, type: 'ic09' },
  { px: 1024, type: 'ic10' }
]
writeFileSync(
  join(buildDir, 'icon.icns'),
  icns(sizes.map(({ px, type }) => ({ type, png: at(px) })))
)
console.log('[icon] wrote build/icon.icns (16–1024, PNG-compressed entries)')
