export interface MigrationChild {
  name: string
  isDirectory: boolean
}

export interface MigrationIo {
  listSource(path: string): Promise<MigrationChild[]>
  readSource(path: string): Promise<Uint8Array>
  hashSource?(path: string): Promise<string>
  listDestination(path: string): Promise<MigrationChild[]>
  readDestination(path: string): Promise<Uint8Array>
  hashDestination?(path: string): Promise<string>
  mkdirDestination(path: string): Promise<void>
  /** Must create only when absent, stage/verify the file, and never replace another document. */
  writeDestination(path: string, bytes: Uint8Array): Promise<void>
  copySourceToDestination?(sourcePath: string, destinationPath: string): Promise<void>
  checkpoint(progress: MigrationProgress): Promise<void>
}

export interface MigrationProgress {
  total: number
  completed: number
  copied: number
  unchanged: number
  conflicts: number
  currentPath?: string
}

export interface MigrationResult extends MigrationProgress {
  verified: true
}

interface SourceNode extends MigrationChild {
  path: string
  children?: SourceNode[]
}

function fold(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('en-US')
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function conflictName(name: string, number: number): string {
  const dot = name.lastIndexOf('.')
  const hasExtension = dot > 0
  const base = hasExtension ? name.slice(0, dot) : name
  const ext = hasExtension ? name.slice(dot) : ''
  const suffix = number === 1 ? ' (Inkfish copy)' : ` (Inkfish copy ${number})`
  return `${base}${suffix}${ext}`
}

function oneMatch(entries: MigrationChild[], name: string): MigrationChild | undefined {
  const matches = entries.filter((entry) => fold(entry.name) === fold(name))
  if (matches.length > 1)
    throw new Error(`The selected folder has ambiguous duplicate names for “${name}”. Nothing was overwritten.`)
  return matches[0]
}

async function collect(io: MigrationIo, parent: string): Promise<SourceNode[]> {
  const entries = await io.listSource(parent)
  const seen = new Set<string>()
  const nodes: SourceNode[] = []
  for (const entry of entries) {
    if (
      !entry.name ||
      entry.name === '.' ||
      entry.name === '..' ||
      entry.name.includes('/') ||
      entry.name.includes('\\')
    ) {
      throw new Error(`Unsafe path in the source vault: ${entry.name}`)
    }
    const key = entry.name
    if (seen.has(key)) throw new Error(`The source vault contains ambiguous duplicate names: ${entry.name}`)
    seen.add(key)
    const path = childPath(parent, entry.name)
    const node: SourceNode = { ...entry, path }
    if (entry.isDirectory) node.children = await collect(io, path)
    nodes.push(node)
  }
  nodes.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
  return nodes
}

function countFiles(nodes: SourceNode[]): number {
  return nodes.reduce((count, node) => count + (node.isDirectory ? countFiles(node.children ?? []) : 1), 0)
}

function sourceManifest(nodes: SourceNode[]): string[] {
  const paths: string[] = []
  for (const node of nodes) {
    paths.push(`${node.isDirectory ? 'D' : 'F'}:${node.path}`)
    if (node.isDirectory) paths.push(...sourceManifest(node.children ?? []))
  }
  return paths.sort()
}

export async function migrateVault(
  io: MigrationIo,
  onProgress?: (progress: MigrationProgress) => void
): Promise<MigrationResult> {
  // Inventory first so a revoked grant or unreadable source fails before any destination writes.
  const tree = await collect(io, '')
  const total = countFiles(tree)
  const result: MigrationProgress = { total, completed: 0, copied: 0, unchanged: 0, conflicts: 0 }
  const verifiedFiles: Array<{ source: string; destination: string }> = []
  const streaming = !!io.hashSource && !!io.hashDestination && !!io.copySourceToDestination

  const report = async (currentPath?: string): Promise<void> => {
    const progress = { ...result, ...(currentPath ? { currentPath } : {}) }
    onProgress?.(progress)
    await io.checkpoint(progress)
  }

  const walk = async (nodes: SourceNode[], destinationParent: string): Promise<void> => {
    for (const node of nodes) {
      let destinationPath = childPath(destinationParent, node.name)
      let siblings = await io.listDestination(destinationParent)
      let match = oneMatch(siblings, node.name)

      if (node.isDirectory) {
        if (match && match.isDirectory) {
          destinationPath = childPath(destinationParent, match.name)
        } else if (match) {
          // A file blocks this source folder; retain it and create a distinct folder name.
          let suffix = 1
          while (true) {
            const candidate = conflictName(node.name, suffix++)
            const candidateMatch = oneMatch(siblings, candidate)
            if (!candidateMatch) {
              destinationPath = childPath(destinationParent, candidate)
              result.conflicts++
              await io.mkdirDestination(destinationPath)
              break
            }
            if (candidateMatch.isDirectory) {
              destinationPath = childPath(destinationParent, candidateMatch.name)
              result.conflicts++
              break
            }
          }
        } else {
          await io.mkdirDestination(destinationPath)
          // Re-read after creation so a provider's name rewriting or collision is rejected.
          siblings = await io.listDestination(destinationParent)
          const created = oneMatch(siblings, node.name)
          if (!created?.isDirectory) throw new Error(`The provider did not create the requested folder “${node.name}”.`)
          destinationPath = childPath(destinationParent, created.name)
        }
        await walk(node.children ?? [], destinationPath)
        continue
      }

      const sourceDigest = streaming ? await io.hashSource!(node.path) : null
      const sourceBytes = streaming ? null : await io.readSource(node.path)
      const sameContent = async (destination: string): Promise<boolean> =>
        streaming
          ? (await io.hashDestination!(destination)) === sourceDigest
          : equalBytes(await io.readDestination(destination), sourceBytes!)
      if (match?.isDirectory) {
        // A directory blocks the file name: preserve it and copy the source under a conflict name.
        match = undefined
      } else if (match) {
        if (await sameContent(childPath(destinationParent, match.name))) {
          result.unchanged++
          result.completed++
          verifiedFiles.push({ source: node.path, destination: childPath(destinationParent, match.name) })
          await report(node.path)
          continue
        }
      }

      let conflictTarget = false
      if (
        match ||
        (await io.listDestination(destinationParent)).some((entry) => fold(entry.name) === fold(node.name))
      ) {
        conflictTarget = true
        let suffix = 1
        while (true) {
          const candidate = conflictName(node.name, suffix++)
          siblings = await io.listDestination(destinationParent)
          const candidateMatch = oneMatch(siblings, candidate)
          if (!candidateMatch) {
            destinationPath = childPath(destinationParent, candidate)
            break
          }
          if (!candidateMatch.isDirectory) {
            if (await sameContent(childPath(destinationParent, candidateMatch.name))) {
              destinationPath = childPath(destinationParent, candidateMatch.name)
              result.unchanged++
              result.conflicts++
              result.completed++
              verifiedFiles.push({ source: node.path, destination: destinationPath })
              await report(node.path)
              conflictTarget = false
              break
            }
          }
        }
      }

      if (result.completed > 0 && verifiedFiles[verifiedFiles.length - 1]?.source === node.path) continue
      if (streaming) await io.copySourceToDestination!(node.path, destinationPath)
      else await io.writeDestination(destinationPath, sourceBytes!)
      const verified = streaming
        ? (await io.hashDestination!(destinationPath)) === sourceDigest
        : equalBytes(await io.readDestination(destinationPath), sourceBytes!)
      if (!verified)
        throw new Error(`Verification failed while copying “${node.path}”. The source original is still intact.`)
      result.copied++
      if (conflictTarget) result.conflicts++
      result.completed++
      verifiedFiles.push({ source: node.path, destination: destinationPath })
      await report(node.path)
    }
  }

  await walk(tree, '')

  // A second complete verification pass is required before a caller may activate the shared vault.
  for (const file of verifiedFiles) {
    if (streaming) {
      const [source, destination] = await Promise.all([
        io.hashSource!(file.source),
        io.hashDestination!(file.destination)
      ])
      if (source !== destination)
        throw new Error(`Final verification failed for “${file.source}”. The source original is still intact.`)
    } else {
      const [source, destination] = await Promise.all([
        io.readSource(file.source),
        io.readDestination(file.destination)
      ])
      if (!equalBytes(source, destination))
        throw new Error(`Final verification failed for “${file.source}”. The source original is still intact.`)
    }
  }
  const finalManifest = sourceManifest(await collect(io, ''))
  if (JSON.stringify(finalManifest) !== JSON.stringify(sourceManifest(tree))) {
    throw new Error(
      'The source vault changed while it was being copied. Retry after edits finish; the source remains intact.'
    )
  }

  const final = { ...result, verified: true as const }
  await io.checkpoint(final)
  return final
}
