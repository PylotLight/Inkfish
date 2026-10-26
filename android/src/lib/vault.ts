/**
 * Vault I/O on top of `expo-file-system` (legacy string API — present in all
 * SDKs; migrate to the `File`/`Directory` API when it is removed).
 *
 * On-disk layout mirrors the Mac app exactly so a future sync is a plain
 * file copy — `.md` files stay the source of truth:
 *
 *   <doc>/inkfish/vault/...          finalised notes + assets/  (Mac: ~/Inkfish/)
 *   <doc>/inkfish/staging/inbox/…    raw captures               (Mac: app-data staging)
 *   <doc>/inkfish/staging/daily/…    day-log scratch
 *   <doc>/inkfish/staging/undone/…   undone routings
 *
 * V1 has no SQLite index (Mac uses FTS5 + sqlite-vec as a *cache*). Lists and
 * search scan files directly — fine for hundreds of notes, and the Mac
 * re-indexes from files on first sync anyway.
 */
export * from './vault/state'
export * from './vault/paths'
export * from './vault/fs'
export * from './vault/scan'
export * from './vault/daily'
export * from './vault/notes'
export * from './vault/inbox'
export * from './vault/assets'
