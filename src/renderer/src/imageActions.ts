import { imageSourceOf } from '../../shared/images'

/**
 * Actions on a rendered editor image (right-click menu, click-select + ⌘C).
 * The clipboard writes go through main (Electron clipboard + nativeImage), so
 * they work in mini windows too and don't depend on renderer focus.
 */

export interface ImageMenuItem {
  label: string
  action: () => void
}

export interface ImageMenuInput {
  /** URL the picture loaded from (`img.currentSrc`); null when it failed to load. */
  url: string | null
  /** The ref's markdown source, `![alt](src)`. Null when the ref can't be found. */
  markdown: string | null
  /** Ref has an explicit `|N` width and the view is editable. */
  resettable: boolean
  copyImage: () => void
  copyPath: () => void
  copyMarkdown: () => void
  reveal: () => void
  reset: () => void
}

/** Menu entries for an image, in order; items that can't apply are left out. Pure (tested). */
export function imageMenuItems(i: ImageMenuInput): ImageMenuItem[] {
  const src = imageSourceOf(i.url)
  const items: ImageMenuItem[] = []
  if (src) items.push({ label: 'Copy image', action: i.copyImage })
  if (src && src.kind !== 'data') {
    items.push({ label: src.kind === 'remote' ? 'Copy image URL' : 'Copy image path', action: i.copyPath })
  }
  if (i.markdown) items.push({ label: 'Copy markdown', action: i.copyMarkdown })
  if (src?.kind === 'vault') items.push({ label: 'Reveal in Finder', action: i.reveal })
  if (i.resettable) items.push({ label: 'Reset size', action: i.reset })
  return items
}

type Api = Window['api']

function api(): Api | null {
  return typeof window !== 'undefined' && window.api ? window.api : null
}

let toastEl: HTMLElement | null = null
let toastTimer = 0

/** Small self-dismissing toast (the app's `.toast glass` look); DOM only, so any editor window can use it. */
export function showToast(msg: string): void {
  if (typeof document === 'undefined') return
  if (!toastEl || !toastEl.isConnected) {
    toastEl = document.createElement('div')
    toastEl.className = 'toast glass lp-toast'
    toastEl.setAttribute('role', 'status')
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastEl?.remove()
    toastEl = null
  }, 1800)
}

/** Re-encode image bytes as a PNG data URL (gif → first frame, webp, …). */
async function toPngDataUrl(mime: string, base64: string): Promise<string | null> {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }))
  try {
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0)
    return c.toDataURL('image/png')
  } finally {
    bmp.close()
  }
}

/** Put the picture loaded from `url` on the system clipboard; toasts the outcome. */
export async function copyImage(url: string | null): Promise<boolean> {
  const a = api()
  if (!a?.images || !url) return false
  try {
    const res = await a.images.copy(url)
    let ok = res.ok
    if (!res.ok && 'decode' in res) {
      const png = await toPngDataUrl(res.decode.mime, res.decode.data)
      ok = png ? await a.images.copyPng(png) : false
    }
    showToast(ok ? 'Image copied' : "Couldn't copy image")
    return ok
  } catch {
    showToast("Couldn't copy image")
    return false
  }
}

async function writeText(text: string): Promise<boolean> {
  const a = api()
  if (a?.clipboard) return a.clipboard.writeText(text)
  await navigator.clipboard.writeText(text)
  return true
}

/** Absolute file path for a vault image, else the remote URL. */
export async function copyImagePath(url: string | null): Promise<void> {
  const src = imageSourceOf(url)
  if (!src || src.kind === 'data') return
  const text = src.kind === 'vault' ? ((await api()?.images.locate(url as string)) ?? src.rel) : src.url
  const ok = await writeText(text).catch(() => false)
  showToast(ok ? (src.kind === 'vault' ? 'Image path copied' : 'Image URL copied') : "Couldn't copy")
}

export async function copyMarkdown(md: string): Promise<void> {
  const ok = await writeText(md).catch(() => false)
  showToast(ok ? 'Markdown copied' : "Couldn't copy")
}

export async function revealImage(url: string | null): Promise<void> {
  if (!url) return
  const ok = await api()
    ?.images.reveal(url)
    .catch(() => false)
  if (!ok) showToast('Image file not found')
}
