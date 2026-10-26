// Vault writer (main process only). Plain `.md` files are the source of
// truth; sqlite (`db.ts`) is just an index. The implementation lives in the
// modules below; this file re-exports the public API so importers
// (`ipc.ts`, `db.ts`, `sync.ts`, `routing.ts`, `watch.ts`, `move.ts`,
// `ai*.ts`, `index.ts`, tests) keep importing `./vault` unchanged.

export * from './vault/types'
export * from './vault/frontmatter'
export * from './vault/appdata'
export * from './vault/paths'
export * from './vault/fs'
export * from './vault/projects'
export * from './vault/bootstrap'
export * from './vault/files'
export * from './vault/trash'
export * from './vault/daily'
export * from './vault/inbox'
export * from './vault/assets'
export * from './vault/meeting'
