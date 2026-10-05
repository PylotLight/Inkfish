import { net, protocol } from 'electron'
import { join, normalize, relative } from 'node:path'
import { resolveVaultRoot, vaultConfigured } from './vault'

/**
 * `asset://` serves vault-relative files (captured images, attachments) to
 * the renderer. Raw relative paths can't resolve from the app bundle, and
 * `file://` is blocked from the dev server — this works in both.
 * Path traversal outside the notes home is rejected.
 */
export function registerAssetProtocol(): void {
  protocol.handle('asset', async (req) => {
    try {
      if (!vaultConfigured()) return new Response('vault not chosen', { status: 404 })
      const raw = req.url.slice('asset://'.length).split('?')[0] ?? ''
      const root = resolveVaultRoot()
      const abs = normalize(join(root, decodeURIComponent(raw)))
      if (abs === root || relative(root, abs).startsWith('..')) {
        return new Response('forbidden', { status: 403 })
      }
      return await net.fetch(`file://${abs}`)
    } catch (err) {
      return new Response(`asset error: ${String(err)}`, { status: 500 })
    }
  })
}
