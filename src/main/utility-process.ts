import type { UtilityProcess } from 'electron'

export const UTILITY_PROCESS_KILL_TIMEOUT_MS = 5_000

/**
 * Ask a utility process to stop gracefully, then force it down if it ignores
 * SIGTERM. Electron 46's UtilityProcess.kill() is graceful on POSIX.
 */
export function stopUtilityProcess(
  child: UtilityProcess,
  forceKill: (pid: number) => void = (pid) => process.kill(pid, 'SIGKILL'),
  timeoutMs = UTILITY_PROCESS_KILL_TIMEOUT_MS
): void {
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const escalate = (): void => {
    timer = undefined
    const pid = child.pid
    if (pid === undefined) return
    try {
      // SIGKILL is unconditional on Windows and non-catchable on POSIX.
      forceKill(pid)
    } catch (error) {
      // The child may exit between the pid check and the OS kill call.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.warn('[ai] could not force-stop the utility process:', error)
      }
    }
  }

  const scheduleEscalation = (): void => {
    if (timer === undefined) timer = setTimeout(escalate, timeoutMs)
  }

  child.once('exit', clearTimer)
  if (child.pid === undefined) {
    // A handler can be replaced while its utility process is still spawning.
    child.once('spawn', () => {
      if (child.pid === undefined) return
      child.kill()
      scheduleEscalation()
    })
  } else {
    scheduleEscalation()
  }
  child.kill()
}
