import { describe, expect, test } from 'bun:test'
import { migrateVault, type MigrationChild, type MigrationIo, type MigrationProgress } from '../src/lib/vault/migration'

class MemoryVault implements MigrationIo {
  sourceFiles = new Map<string, Uint8Array>()
  sourceDirs = new Set<string>([''])
  destinationFiles = new Map<string, Uint8Array>()
  destinationDirs = new Set<string>([''])
  checkpoints: MigrationProgress[] = []
  writeCount = 0
  failAfterWrites: number | null = null
  revokeAfterWrites: number | null = null
  revoked = false

  addSource(path: string, text: string): void {
    this.addParents(path, this.sourceDirs)
    this.sourceFiles.set(path, new TextEncoder().encode(text))
  }

  addDestination(path: string, text: string): void {
    this.addParents(path, this.destinationDirs)
    this.destinationFiles.set(path, new TextEncoder().encode(text))
  }

  private addParents(path: string, dirs: Set<string>): void {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }

  private checkPermission(): void {
    if (this.revoked) throw new Error('permission revoked')
  }

  private children(path: string, files: Map<string, Uint8Array>, dirs: Set<string>): MigrationChild[] {
    const prefix = path ? `${path}/` : ''
    const out = new Map<string, MigrationChild>()
    for (const dir of dirs) {
      if (dir === path || !dir.startsWith(prefix)) continue
      const name = dir.slice(prefix.length).split('/')[0]!
      out.set(name, { name, isDirectory: true })
    }
    for (const file of files.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      if (!rest || rest.includes('/')) continue
      if (!out.has(rest)) out.set(rest, { name: rest, isDirectory: false })
    }
    return [...out.values()]
  }

  async listSource(path: string): Promise<MigrationChild[]> {
    return this.children(path, this.sourceFiles, this.sourceDirs)
  }

  async readSource(path: string): Promise<Uint8Array> {
    const bytes = this.sourceFiles.get(path)
    if (!bytes) throw new Error(`source missing: ${path}`)
    return bytes.slice()
  }

  async listDestination(path: string): Promise<MigrationChild[]> {
    this.checkPermission()
    return this.children(path, this.destinationFiles, this.destinationDirs)
  }

  async readDestination(path: string): Promise<Uint8Array> {
    this.checkPermission()
    const bytes = this.destinationFiles.get(path)
    if (!bytes) throw new Error(`destination missing: ${path}`)
    return bytes.slice()
  }

  async mkdirDestination(path: string): Promise<void> {
    this.checkPermission()
    this.addParents(path, this.destinationDirs)
    if (this.destinationFiles.has(path)) throw new Error(`file blocks folder: ${path}`)
    this.destinationDirs.add(path)
  }

  async writeDestination(path: string, bytes: Uint8Array): Promise<void> {
    this.checkPermission()
    if (this.destinationFiles.has(path) || this.destinationDirs.has(path)) throw new Error(`destination exists: ${path}`)
    if (this.failAfterWrites !== null && this.writeCount >= this.failAfterWrites) throw new Error('simulated partial copy failure')
    this.addParents(path, this.destinationDirs)
    this.destinationFiles.set(path, bytes.slice())
    this.writeCount++
    if (this.revokeAfterWrites !== null && this.writeCount >= this.revokeAfterWrites) this.revoked = true
  }

  async checkpoint(progress: MigrationProgress): Promise<void> {
    this.checkpoints.push({ ...progress })
  }

  sourceText(path: string): string {
    return new TextDecoder().decode(this.sourceFiles.get(path))
  }

  destinationText(path: string): string | undefined {
    const bytes = this.destinationFiles.get(path)
    return bytes ? new TextDecoder().decode(bytes) : undefined
  }
}

describe('shared-vault migration', () => {
  test('never overwrites a same-name Obsidian file; creates a readable conflict copy', async () => {
    const io = new MemoryVault()
    io.addSource('work/Plan.md', 'private plan')
    io.addDestination('work/Plan.md', 'Obsidian plan')

    const result = await migrateVault(io)

    expect(result.verified).toBe(true)
    expect(result.conflicts).toBe(1)
    expect(io.destinationText('work/Plan.md')).toBe('Obsidian plan')
    expect(io.destinationText('work/Plan (Inkfish copy).md')).toBe('private plan')
    expect(io.sourceText('work/Plan.md')).toBe('private plan')
  })

  test('preserves case-variant duplicate paths as merged conflict copies', async () => {
    const io = new MemoryVault()
    io.addSource('Work/Readme.md', 'uppercase path')
    io.addSource('work/readme.md', 'lowercase path')

    const result = await migrateVault(io)
    const copied = [...io.destinationFiles.keys()].filter((path) => /readme/i.test(path))

    expect(result.verified).toBe(true)
    expect(result.conflicts).toBeGreaterThanOrEqual(1)
    expect(copied).toHaveLength(2)
    expect(copied.map((path) => io.destinationText(path)).sort()).toEqual(['lowercase path', 'uppercase path'])
  })

  test('destination providers that expose ambiguous duplicate names fail safely', async () => {
    const io = new MemoryVault()
    io.addSource('Note.md', 'private')
    io.addDestination('Note.md', 'existing one')
    io.addDestination('NOTE.md', 'existing two')

    await expect(migrateVault(io)).rejects.toThrow('ambiguous duplicate names')
    expect(io.sourceText('Note.md')).toBe('private')
    expect(io.destinationText('Note.md')).toBe('existing one')
    expect(io.destinationText('NOTE.md')).toBe('existing two')
  })

  test('permission loss during migration leaves originals intact and a later retry resumes safely', async () => {
    const io = new MemoryVault()
    io.addSource('a.md', 'first')
    io.addSource('b.md', 'second')
    io.revokeAfterWrites = 1

    await expect(migrateVault(io)).rejects.toThrow('permission revoked')
    expect(io.sourceText('a.md')).toBe('first')
    expect(io.sourceText('b.md')).toBe('second')

    io.revoked = false
    io.revokeAfterWrites = null
    const result = await migrateVault(io)
    expect(result.verified).toBe(true)
    expect(result.unchanged).toBe(1)
    expect(io.destinationText('a.md')).toBe('first')
    expect(io.destinationText('b.md')).toBe('second')
    expect(io.sourceText('a.md')).toBe('first')
    expect(io.sourceText('b.md')).toBe('second')
  })

  test('partial copy failure can be retried idempotently without duplicating the first file', async () => {
    const io = new MemoryVault()
    io.addSource('one.md', 'one')
    io.addSource('two.md', 'two')
    io.failAfterWrites = 1

    await expect(migrateVault(io)).rejects.toThrow('simulated partial copy failure')
    expect(io.destinationText('one.md')).toBe('one')
    expect(io.sourceText('one.md')).toBe('one')
    expect(io.sourceText('two.md')).toBe('two')

    io.failAfterWrites = null
    const result = await migrateVault(io)
    expect(result.verified).toBe(true)
    expect(result.unchanged).toBe(1)
    expect(result.copied).toBe(1)
    expect([...io.destinationFiles.keys()].sort()).toEqual(['one.md', 'two.md'])
    expect(io.sourceText('one.md')).toBe('one')
    expect(io.sourceText('two.md')).toBe('two')
  })

  test('uses streaming provider hashes and copies when the adapter supports them', async () => {
    const io = new MemoryVault()
    io.addSource('assets/photo.jpg', 'binary-placeholder')
    const sourceRead = io.readSource.bind(io)
    const destinationRead = io.readDestination.bind(io)
    const write = io.writeDestination.bind(io)
    const streaming = io as MemoryVault & MigrationIo
    streaming.hashSource = async (path) => new TextDecoder().decode(await sourceRead(path))
    streaming.hashDestination = async (path) => new TextDecoder().decode(await destinationRead(path))
    streaming.copySourceToDestination = async (source, destination) => write(destination, await sourceRead(source))
    streaming.readSource = async () => { throw new Error('byte-array source read should not be used') }
    streaming.readDestination = async () => { throw new Error('byte-array destination read should not be used') }
    streaming.writeDestination = async () => { throw new Error('byte-array write should not be used') }

    const result = await migrateVault(streaming)

    expect(result.verified).toBe(true)
    expect(result.copied).toBe(1)
    expect(io.destinationText('assets/photo.jpg')).toBe('binary-placeholder')
  })
})
