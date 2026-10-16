import { app } from 'electron'
import { dirname, join } from 'node:path'
import { resolveProfile, shouldIsolateUserData, type AppProfile } from '../shared/profile'

/**
 * Applies the app profile (shared/profile.ts) as a side effect of import. index.ts imports this
 * FIRST, before anything touches userData or takes the single-instance lock: the lock, the
 * config/vault choice, sync pairing and every settings file all live under userData, so moving
 * userData is what keeps a dev run off the release app's state.
 */
export const profile: AppProfile = resolveProfile({
  isPackaged: app.isPackaged,
  profileEnv: process.env['INKFISH_PROFILE'],
  shortcutsEnv: process.env['INKFISH_SHORTCUTS']
})

// Leave an explicitly chosen userData alone (--user-data-dir, smoke tests) — Surffish #69.
if (shouldIsolateUserData(profile, dirname(app.getPath('userData')), app.getPath('appData'))) {
  app.setName(profile.name)
  app.setPath('userData', join(app.getPath('appData'), profile.name))
}
if (profile.kind !== 'release') {
  console.log(`[inkfish] profile "${profile.name}" — userData ${app.getPath('userData')}`)
}
