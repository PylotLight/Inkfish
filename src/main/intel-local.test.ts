import { describe, expect, test } from 'bun:test'
import {
  INTEL_RUNTIMES,
  isIntelRuntimeId,
  isLoopbackIntelUrl,
  isSupportedLfm3TextModelId,
  normalizeIntelBaseUrl
} from '../shared/intel-runtime'
import { completeLocalChat, localIntelStatus, runLocalIntel } from './intel-local'

const config = {
  engine: 'llama.cpp' as const,
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M'
}

function response(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }), {
    headers: { 'content-type': 'application/json' }
  })
}

describe('LFM3 local runtime catalog', () => {
  test('includes only runtimes verified for LFM3-1.7B and an OpenAI-compatible endpoint', () => {
    expect(INTEL_RUNTIMES.map((runtime) => runtime.id)).toEqual([
      'llama.cpp',
      'ollama',
      'lm-studio',
      'vllm',
      'sglang',
      'custom'
    ])
    expect(INTEL_RUNTIMES.every((runtime) => isSupportedLfm3TextModelId(runtime.modelExample))).toBe(true)
    expect(isIntelRuntimeId('uzu')).toBe(false)
    expect(isIntelRuntimeId('mlx-lm')).toBe(false)
    expect(isIntelRuntimeId('onnx')).toBe(false)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B-GGUF:Q4_K_M')).toBe(true)
    expect(isSupportedLfm3TextModelId('lfm3')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-VL-2B')).toBe(false)
    expect(isSupportedLfm3TextModelId('some-other-model')).toBe(false)
    expect(isSupportedLfm3TextModelId('random-LFM3-1.7B-label')).toBe(false)
  })

  test('allows only loopback HTTP(S) endpoints and normalizes a safe local URL', () => {
    expect(isLoopbackIntelUrl('http://localhost:8000/v1')).toBe(true)
    expect(isLoopbackIntelUrl('http://[::1]:8000/v1')).toBe(true)
    expect(isLoopbackIntelUrl('http://user:password@localhost:8000/v1')).toBe(false)
    expect(isLoopbackIntelUrl('https://example.com/v1')).toBe(false)
    expect(isLoopbackIntelUrl('file:///tmp/model')).toBe(false)
    expect(normalizeIntelBaseUrl('http://localhost:8000/v1///', config.baseUrl)).toBe('http://localhost:8000/v1')
    expect(normalizeIntelBaseUrl('https://example.com/v1', config.baseUrl)).toBe(config.baseUrl)
  })
})

describe('local engine status and chat', () => {
  test('probes /models and returns the configured LFM3 runtime', async () => {
    let url = ''
    const status = await localIntelStatus(config, async (input) => {
      url = String(input)
      return new Response(JSON.stringify({ data: [{ id: config.model }] }), { status: 200 })
    })
    expect(url).toBe('http://127.0.0.1:8080/v1/models')
    expect(status).toMatchObject({ available: true, reason: 'available', runtime: 'llama.cpp' })
  })

  test('rejects non-LFM3 model IDs and vision-model IDs before making a request', async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      return new Response(JSON.stringify({ data: [{ id: config.model }] }), { status: 200 })
    }
    expect((await localIntelStatus({ ...config, model: 'some-other-model' }, fetcher)).reason).toBe('invalidModel')
    expect((await localIntelStatus({ ...config, model: 'LiquidAI/LFM3-VL-2B' }, fetcher)).reason).toBe('invalidModel')
    expect(calls).toBe(0)
  })

  test('rejects a valid LFM3 ID that is not advertised by the local server', async () => {
    const status = await localIntelStatus(
      config,
      async () => new Response(JSON.stringify({ data: [{ id: 'different-model' }] }), { status: 200 })
    )
    expect(status).toMatchObject({ available: false, reason: 'modelUnavailable' })
  })

  test('does not probe non-loopback URLs', async () => {
    let calls = 0
    const status = await localIntelStatus({ ...config, baseUrl: 'https://example.com/v1' }, async () => {
      calls++
      return new Response('{}')
    })
    expect(status.reason).toBe('invalidUrl')
    expect(calls).toBe(0)
  })

  test('blocks completion to non-loopback URLs before calling fetch', async () => {
    let calls = 0
    await expect(
      completeLocalChat(
        { ...config, baseUrl: 'https://example.com/v1' },
        [{ role: 'user', content: 'private note' }],
        {},
        async () => {
          calls++
          return response('should not run')
        }
      )
    ).rejects.toThrow('must use localhost')
    expect(calls).toBe(0)
  })

  test('blocks non-LFM3 completion before calling fetch', async () => {
    let calls = 0
    await expect(
      completeLocalChat(
        { ...config, model: 'other-model' },
        [{ role: 'user', content: 'private note' }],
        {},
        async () => {
          calls++
          return response('should not run')
        }
      )
    ).rejects.toThrow('Only LFM3-1.7B text model IDs')
    expect(calls).toBe(0)
  })

  test('does not report an arbitrary HTTP response as a compatible model server', async () => {
    const status = await localIntelStatus(config, async () => new Response('<html>not an API</html>', { status: 200 }))
    expect(status).toMatchObject({ available: false, reason: 'incompatible' })
  })

  test('sends deterministic settings without credentials and reads usage metrics', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const result = await completeLocalChat(
      config,
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'document' }
      ],
      { temperature: 0, maxTokens: 99 },
      async (input, init) => {
        seen.push({ url: String(input), init: init ?? {} })
        return response('{"ok":true}', { prompt_tokens: 10, completion_tokens: 3 })
      }
    )
    expect(seen[0]?.url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBeUndefined()
    expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({
      model: config.model,
      temperature: 0,
      max_tokens: 99,
      stream: false
    })
    expect(result).toMatchObject({ content: '{"ok":true}', promptTokens: 10, completionTokens: 3 })
  })

  test('runs cleanup as plain text and reports local provenance', async () => {
    const result = await runLocalIntel(
      {
        config,
        task: 'cleanup',
        text: 'um send the invoice friday',
        style: 'standard',
        instructions: '',
        temperature: 0,
        cleanup: false
      },
      async (input) =>
        String(input).endsWith('/models')
          ? new Response(JSON.stringify({ data: [{ id: config.model }] }))
          : response('Send the invoice Friday.')
    )
    expect(result).toMatchObject({ task: 'cleanup', text: 'Send the invoice Friday.', provider: 'local' })
    expect(result.runtime).toContain('llama.cpp')
  })

  test('parses structured organise results and bounds list fields', async () => {
    const result = await runLocalIntel(
      {
        config,
        task: 'organize',
        text: 'Send the invoice Friday.',
        projects: ['Finance'],
        style: 'standard',
        instructions: '',
        temperature: 0,
        cleanup: false
      },
      async (input, init) => {
        if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: config.model }] }))
        const payload = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        expect(payload.messages[1]?.content).toContain('Finance')
        return response(
          JSON.stringify({
            title: 'Invoice follow-up',
            project: 'Finance',
            tags: ['invoice', 'finance', 'due', 'accounts', 'billing', 'extra'],
            summary: 'Invoice follow-up is needed.',
            actionItems: ['Send the invoice Friday.'],
            cleaned: ''
          })
        )
      }
    )
    expect(result).toMatchObject({
      provider: 'local',
      title: 'Invoice follow-up',
      project: 'Finance',
      tags: ['invoice', 'finance', 'due', 'accounts', 'billing'],
      actionItems: ['Send the invoice Friday.']
    })
  })

  test('rejects malformed structured output instead of silently accepting it', async () => {
    await expect(
      runLocalIntel(
        {
          config,
          task: 'summarize',
          text: 'A short document.',
          style: 'standard',
          instructions: '',
          temperature: 0,
          cleanup: false
        },
        async (input) =>
          String(input).endsWith('/models')
            ? new Response(JSON.stringify({ data: [{ id: config.model }] }))
            : response('not-json')
      )
    ).rejects.toThrow('Local model did not return a JSON object')
  })
})
