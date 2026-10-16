import { afterEach, describe, expect, test } from 'bun:test'
import { AiNotConnectedError, runAiProcess } from './nativeAi'

type G = { window?: unknown; LanguageModel?: unknown }
const g = globalThis as unknown as G

function setStatus(connected: boolean): void {
  g.window = { api: { aiApi: { status: async () => ({ connected }) } } }
}

afterEach(() => {
  delete g.window
  delete g.LanguageModel
})

describe('Prompt API path (renderer)', () => {
  test('no API connected: clear error, the Prompt API is never called', async () => {
    setStatus(false)
    let created = false
    g.LanguageModel = { availability: async () => 'available', create: async () => ((created = true), {}) }
    const err = await runAiProcess({ action: 'tidy', text: '# hi' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AiNotConnectedError)
    expect(String((err as Error).message)).toContain('Settings › AI')
    expect(created).toBe(false)
  })

  test('connected: system prompt via initialPrompts, reply streamed through promptStreaming', async () => {
    setStatus(true)
    let initial: unknown
    let destroyed = false
    g.LanguageModel = {
      availability: async () => 'available',
      create: async (opts: { initialPrompts: unknown }) => {
        initial = opts.initialPrompts
        return {
          promptStreaming: () =>
            new ReadableStream<string>({
              start(c) {
                c.enqueue('# Hi\n\n')
                c.enqueue('- item')
                c.close()
              }
            }),
          destroy: () => (destroyed = true)
        }
      }
    }
    const chunks: string[] = []
    const r = await runAiProcess({ action: 'tidy', text: '---\na: 1\n---\n# hi\n* item', onChunk: (c) => chunks.push(c) })
    expect(r.text).toBe('---\na: 1\n---\n# Hi\n\n- item\n')
    expect(chunks).toEqual(['# Hi\n\n', '# Hi\n\n- item'])
    expect((initial as Array<{ role: string }>)[0]?.role).toBe('system')
    expect(destroyed).toBe(true)
  })

  test('handler registered but unavailable: says so', async () => {
    setStatus(true)
    g.LanguageModel = { availability: async () => 'unavailable', create: async () => ({}) }
    await expect(runAiProcess({ action: 'tidy', text: 'x' })).rejects.toThrow(/unavailable/)
  })
})
