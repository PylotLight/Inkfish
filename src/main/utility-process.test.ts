import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import type { UtilityProcess } from 'electron'
import { stopUtilityProcess } from './utility-process'

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 321
  killCalls = 0

  kill(): boolean {
    this.killCalls += 1
    return true
  }
}

const asUtilityProcess = (child: FakeUtilityProcess): UtilityProcess => child as unknown as UtilityProcess

describe('stopUtilityProcess', () => {
  test('escalates when a child ignores the graceful kill', async () => {
    const child = new FakeUtilityProcess()
    const forceKilled: number[] = []

    stopUtilityProcess(asUtilityProcess(child), (pid) => forceKilled.push(pid), 10)

    expect(child.killCalls).toBe(1)
    expect(forceKilled).toEqual([])
    await Bun.sleep(25)
    expect(forceKilled).toEqual([321])
  })

  test('cancels escalation when the child exits in time', async () => {
    const child = new FakeUtilityProcess()
    const forceKilled: number[] = []

    stopUtilityProcess(asUtilityProcess(child), (pid) => forceKilled.push(pid), 10)
    child.pid = undefined
    child.emit('exit', 0)

    await Bun.sleep(25)
    expect(forceKilled).toEqual([])
  })

  test('retries graceful shutdown after a replaced child finishes spawning', async () => {
    const child = new FakeUtilityProcess()
    child.pid = undefined
    const forceKilled: number[] = []

    stopUtilityProcess(asUtilityProcess(child), (pid) => forceKilled.push(pid), 10)
    expect(child.killCalls).toBe(1)

    child.pid = 654
    child.emit('spawn')
    expect(child.killCalls).toBe(2)
    await Bun.sleep(25)
    expect(forceKilled).toEqual([654])
  })
})
