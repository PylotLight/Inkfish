import { execFileSync } from 'node:child_process'

export type LsofRunner = (command: string, args: string[]) => string

function runLsof(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

/**
 * Confirm that a specific process owns a loopback TCP listening socket. Used only for the managed
 * llama-server path; manual local endpoints remain user-configured. lsof is part of macOS and is
 * also used when available on Linux for the benchmark CLI.
 */
export function loopbackPortOwnedByPid(pid: number, port: number, runner: LsofRunner = runLsof): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) return false
  const command = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof'
  try {
    const output = runner(command, ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN'])
    return output.split(/\r?\n/).some((line) => {
      const match = /\bTCP\s+(\S+)\s+\(LISTEN\)/.exec(line)
      return match?.[1] === `127.0.0.1:${port}`
    })
  } catch {
    return false
  }
}
