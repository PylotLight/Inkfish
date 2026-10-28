import { describe, expect, test } from 'bun:test'
import {
  INTEL_RUNTIMES,
  isIntelRuntimeId,
  isLoopbackIntelUrl,
  isSupportedLfmModelId,
  isSupportedLfm3TextModelId,
  normalizeIntelBaseUrl
} from '../shared/intel-runtime'
import { completeLocalChat, completeStructuredJsonWithFallback, localIntelStatus, runLocalIntel } from './intel-local'
import { sanitizeIntelImages } from './intelligence'

const config = {
  engine: 'llama.cpp' as const,
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M'
}
const visionConfig = { ...config, model: 'LiquidAI/LFM3-VL-2B-GGUF:Q4_K_M' }
const mlxConfig = {
  engine: 'mlx-vlm' as const,
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: 'LiquidAI/LFM3-1.7B'
}
const mlxVisionConfig = { ...mlxConfig, model: 'LiquidAI/LFM3-VL-2B' }
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jclcAAAAASUVORK5CYII='

function response(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }), {
    headers: { 'content-type': 'application/json' }
  })
}

describe('LFM3 local runtime catalog', () => {
  test('catalogs runtimes that accept LFM3-1.7B and an OpenAI-compatible endpoint', () => {
    expect(INTEL_RUNTIMES.map((runtime) => runtime.id)).toEqual([
      'llama.cpp-managed',
      'onnx-managed',
      'mlx-vlm',
      'llama.cpp',
      'ollama',
      'lm-studio',
      'vllm',
      'sglang',
      'custom'
    ])
    expect(INTEL_RUNTIMES.every((runtime) => isSupportedLfm3TextModelId(runtime.modelExample))).toBe(true)
    expect(isIntelRuntimeId('uzu')).toBe(false)
    expect(isIntelRuntimeId('mlx-vlm')).toBe(true)
    expect(isIntelRuntimeId('mlx-lm')).toBe(false)
    expect(isIntelRuntimeId('onnx')).toBe(false)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B-GGUF:Q4_K_M')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B-ONNX')).toBe(true)
    expect(isSupportedLfm3TextModelId('lfm3')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-VL-2B')).toBe(false)
    expect(isSupportedLfm3TextModelId('some-other-model')).toBe(false)
    expect(isSupportedLfm3TextModelId('random-LFM3-1.7B-label')).toBe(false)
    expect(isSupportedLfmModelId('llama.cpp-managed', visionConfig.model)).toBe(true)
    expect(isSupportedLfmModelId('llama.cpp', 'LiquidAI/LFM3-VL-2B')).toBe(true)
    expect(isSupportedLfmModelId('ollama', 'LiquidAI/LFM3-VL-2B')).toBe(false)
    expect(isSupportedLfmModelId('onnx-managed', 'LiquidAI/LFM3-1.7B-ONNX')).toBe(true)
    expect(isSupportedLfmModelId('onnx-managed', 'LiquidAI/LFM3-VL-2B-ONNX')).toBe(true)
    expect(isSupportedLfm3TextModelId('LiquidAI/LFM3-1.7B')).toBe(true)
    expect(isSupportedLfmModelId('mlx-vlm', mlxConfig.model)).toBe(true)
    expect(isSupportedLfmModelId('mlx-vlm', mlxVisionConfig.model)).toBe(true)
    expect(isSupportedLfmModelId('mlx-vlm', 'LiquidAI/LFM3-1.7B-ONNX')).toBe(false)
    expect(isSupportedLfmModelId('mlx-vlm', config.model)).toBe(false)
    expect(isSupportedLfmModelId('llama.cpp', mlxConfig.model)).toBe(false)
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

  test('validates image dimensions before a decoder can allocate large pixel buffers', () => {
    expect(sanitizeIntelImages([{ mime: 'image/png', data: tinyPng }])).toHaveLength(1)
    const oversized = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversized)
    oversized.writeUInt32BE(13, 8)
    oversized.write('IHDR', 12, 'ascii')
    oversized.writeUInt32BE(5000, 16)
    oversized.writeUInt32BE(5000, 20)
    expect(() => sanitizeIntelImages([{ mime: 'image/png', data: oversized.toString('base64') }])).toThrow(
      '16-megapixel processing limit'
    )
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

  test('managed ONNX bypasses API probing and reports managed-model readiness directly', async () => {
    let calls = 0
    const status = await localIntelStatus(
      {
        engine: 'onnx-managed',
        baseUrl: 'https://not-a-local-endpoint.invalid/v1',
        model: 'LiquidAI/LFM3-1.7B-ONNX'
      },
      async () => {
        calls++
        return new Response('{}')
      }
    )
    expect(status.runtime).toBe('ONNX Runtime (managed)')
    expect(['available', 'modelNotDownloaded', 'platformUnsupported', 'runtimeMissing']).toContain(status.reason)
    expect(calls).toBe(0)
  })

  test('reports the MLX-VLM Apple-silicon limit before probing on unsupported platforms', async () => {
    let calls = 0
    const status = await localIntelStatus(mlxConfig, async () => {
      calls++
      return new Response(JSON.stringify({ data: [{ id: mlxConfig.model }] }))
    })
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      expect(status).toMatchObject({ available: false, reason: 'platformUnsupported' })
      expect(status.detail).toContain('macOS on Apple silicon')
      expect(calls).toBe(0)
    } else {
      expect(status).toMatchObject({ available: true, runtime: 'MLX-VLM (experimental)' })
      expect(calls).toBe(1)
    }
  })

  test('rejects unrelated and cross-runtime VL IDs before making a request', async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      return new Response(JSON.stringify({ data: [{ id: config.model }] }), { status: 200 })
    }
    expect((await localIntelStatus({ ...config, model: 'some-other-model' }, fetcher)).reason).toBe('invalidModel')
    expect(
      (await localIntelStatus({ ...config, engine: 'ollama', model: 'LiquidAI/LFM3-VL-2B' }, fetcher)).reason
    ).toBe('invalidModel')
    expect(calls).toBe(0)
  })

  test('probes the vision model only when the selected llama.cpp server advertises it', async () => {
    const status = await localIntelStatus(
      visionConfig,
      async () => new Response(JSON.stringify({ data: [{ id: visionConfig.model }] }), { status: 200 })
    )
    expect(status).toMatchObject({ available: true, reason: 'available', runtime: 'llama.cpp' })
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

  test('refuses managed inference when the selected process does not own the endpoint', async () => {
    const managed = {
      ...config,
      engine: 'llama.cpp-managed' as const,
      model: 'LiquidAI/LFM3-1.7B-GGUF:Q4_K_M',
      expectedPid: 999999
    }
    let calls = 0
    const status = await localIntelStatus(managed, async () => {
      calls++
      return new Response(JSON.stringify({ data: [{ id: managed.model }] }))
    })
    expect(status).toMatchObject({ available: false, reason: 'unreachable' })
    await expect(
      completeLocalChat(managed, [{ role: 'user', content: 'private document' }], {}, async () => {
        calls++
        return response('must not be sent')
      })
    ).rejects.toThrow('does not own this loopback port')
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
    ).rejects.toThrow('The selected model is not supported by this local runtime')
    expect(calls).toBe(0)
  })

  test('sends local PNG data URLs only to the LFM3-VL checkpoint', async () => {
    let payload: Record<string, unknown> | undefined
    await completeLocalChat(
      visionConfig,
      [{ role: 'user', content: 'Read this invoice', images: [{ mime: 'image/png', data: tinyPng }] }],
      {},
      async (_input, init) => {
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>
        return response('ok')
      }
    )
    expect(payload?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this invoice' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } }
        ]
      }
    ])

    let calls = 0
    await expect(
      completeLocalChat(
        config,
        [{ role: 'user', content: 'Read this invoice', images: [{ mime: 'image/png', data: tinyPng }] }],
        {},
        async () => {
          calls++
          return response('must not be sent')
        }
      )
    ).rejects.toThrow('Image inputs require the LFM3-VL-2B vision model')
    expect(calls).toBe(0)
  })

  test('serializes a local image request for the exact experimental MLX-VLM vision checkpoint', async () => {
    let payload: Record<string, unknown> | undefined
    let url = ''
    await completeLocalChat(
      mlxVisionConfig,
      [{ role: 'user', content: 'Read this invoice', images: [{ mime: 'image/png', data: tinyPng }] }],
      {},
      async (input, init) => {
        url = String(input)
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>
        return response('mocked API response')
      }
    )
    expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect(payload).toMatchObject({
      model: 'LiquidAI/LFM3-VL-2B',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this invoice' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPng}` } }
          ]
        }
      ]
    })
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

  test('retries malformed ONNX structured output with thinking off', async () => {
    const levels: string[] = []
    const completed = await completeStructuredJsonWithFallback(
      async (thinkingLevel) => {
        levels.push(thinkingLevel)
        return {
          content:
            levels.length === 1 ? 'The reasoning trace used the output budget.' : '{"summary":"A short summary."}',
          ms: 1
        }
      },
      'on',
      true
    )

    expect(levels).toEqual(['on', 'off'])
    expect(completed.value).toEqual({ summary: 'A short summary.' })
    expect(completed.result.content).toBe('{"summary":"A short summary."}')
  })

  test('does not retry malformed output when thinking is already off or fallback is unsupported', async () => {
    let calls = 0
    const generate = async () => {
      calls++
      return { content: 'not JSON', ms: 1 }
    }

    await expect(completeStructuredJsonWithFallback(generate, 'off', true)).rejects.toThrow(
      'Local model did not return a JSON object'
    )
    await expect(completeStructuredJsonWithFallback(generate, 'on', false)).rejects.toThrow(
      'Local model did not return a JSON object'
    )
    expect(calls).toBe(2)
  })
})
