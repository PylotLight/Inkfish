import { net, protocol } from 'electron'
import { join, normalize, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assetPathFromUrl } from '../shared/images'
import { resolveVaultRoot, vaultConfigured } from './vault'

/**
 * `asset://vault/<path>` serves vault-relative files (captured images,
 * attachments) to the renderer. Raw relative paths can't resolve from the app
 * bundle, and `file://` is blocked from the dev server — this works in both.
 * The legacy `asset://<path>` form is still accepted. Path traversal outside
 * the notes home is rejected.
 */
export function registerAssetProtocol(): void {
  protocol.handle('asset', async (req) => {
    try {
      if (!vaultConfigured()) return new Response('vault not chosen', { status: 404 })
      const rel = assetPathFromUrl(req.url)
      if (!rel) return new Response('forbidden', { status: 403 })
      const root = resolveVaultRoot()
      const abs = normalize(join(root, rel))
      if (abs === root || relative(root, abs).startsWith('..')) {
        return new Response('forbidden', { status: 403 })
      }
      // pathToFileURL escapes spaces, `#`, `%` etc. — a bare `file://${abs}`
      // breaks on any of those in a folder or file name.
      return await net.fetch(pathToFileURL(abs).toString())
    } catch (err) {
      return new Response(`asset error: ${String(err)}`, { status: 500 })
    }
  })
}
