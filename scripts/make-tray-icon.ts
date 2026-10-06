// Derives tray icons from the master logo at assets/Inkfish_logo.png —
// zero dependencies. Run with: bun scripts/make-tray-icon.ts (or: bun run assets)
//
// The logo art is a pale squid on a near-black ground, so the silhouette is
// the bright half of the luminance range: smoothstep(60, 160) of luminance
// becomes alpha. macOS entries stay solid-white template images (naming +
// setTemplateImage => auto dark/light); Windows/Linux gets a dark slate glyph.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, resampleMask } from './lib/png'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(root, 'assets')
mkdirSync(assetsDir, { recursive: true })

const master = decodePng(new Uint8Array(readFileSync(join(assetsDir, 'Inkfish_logo.png'))))

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/** Squid silhouette as a float mask: 1 = squid core, 0 = dark ground. */
function silhouette(): Float32Array {
  const { width, height, data } = master
  const mask = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4]!
    const g = data[i * 4 + 1]!
    const b = data[i * 4 + 2]!
    mask[i] = smoothstep(60, 160, 0.2126 * r + 0.7152 * g + 0.0722 * b)
  }
  return mask
}

/** Render the mask at `size`px in a solid color, with 1px padding for legibility. */
function render(size: number, rgb: [number, number, number]): Buffer {
  const content = size - 2
  const small = resampleMask(silhouette(), master.width, master.height, content, content)
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < content; y++) {
    for (let x = 0; x < content; x++) {
      let a = Math.round(small[y * content + x]! * 255)
      if (a < 8) a = 0 // drop resampling dust so the menu-bar glyph stays crisp
      const o = ((y + 1) * size + (x + 1)) * 4
      rgba[o] = rgb[0]
      rgba[o + 1] = rgb[1]
      rgba[o + 2] = rgb[2]
      rgba[o + 3] = a
    }
  }
  return encodePng(size, size, rgba)
}

const outputs: Array<{ name: string; size: number; rgb: [number, number, number] }> = [
  { name: 'trayTemplate.png', size: 22, rgb: [255, 255, 255] }, // macOS template
  { name: 'trayTemplate@2x.png', size: 44, rgb: [255, 255, 255] },
  { name: 'tray.png', size: 32, rgb: [43, 47, 54] } // Windows/Linux glyph
]

for (const { name, size, rgb } of outputs) {
  const png = render(size, rgb)
  writeFileSync(join(assetsDir, name), png)
  console.log(`wrote assets/${name} (${size}x${size}, ${png.length} bytes)`)
}
