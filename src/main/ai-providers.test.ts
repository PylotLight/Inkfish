import { describe, expect, test } from 'bun:test'
import { anthropicBody, complete, createProvider, modelFor, openAIBody, readSse, thinkingBudget } from './ai-providers'

const KEY = 'sk-test-secret-123'

function sse(blocks: string[], contentType = 'text/event-stream'): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      // Split mid-block to exercise buffering.
      const all = blocks.join('')
      c.enqueue(enc.encode(all.slice(0, 7)))
      c.enqueue(enc.encode(all.slice(7)))
      c.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

describe('readSse', () => {
  test('parses events across chunk boundaries', async () => {
    const out: Array<{ event: string; data: string }> = []
    for await (const e of readSse(sse(['event: a\ndata: 1\n\n', 'data: 2\n\n']).body!)) out.push(e)
    expect(out).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: '2' }
    ])
  })
})

describe('OpenAI-compatible provider', () => {
  test('streams deltas, sends bearer key + messages', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const p = createProvider({ kind: 'openai', baseUrl: 'https://api.example/v1', model: 'm1', apiKey: KEY }, async (url, init) => {
      seen = { url, init }
      return sse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`,
        'data: [DONE]\n\n'
      ])
    })
    const parts: string[] = []
    for await (const d of p.stream([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }])) parts.push(d)
    expect(parts).toEqual(['Hel', 'lo'])
    expect(seen!.url).toBe('https://api.example/v1/chat/completions')
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(String(seen!.init.body))
    expect(body).toMatchObject({ model: 'm1', stream: true, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] })
  })

  test('no key (local server): no authorization header; plain JSON reply accepted', async () => {
    let headers: Record<string, string> = {}
    const p = createProvider({ kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: '', apiKey: null }, async (_u, init) => {
      headers = init.headers as Record<string, string>
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { headers: { 'content-type': 'application/json' } })
    })
    expect(await complete(p, [{ role: 'user', content: 'hi' }])).toBe('OK')
    expect(headers.authorization).toBeUndefined()
  })

  test('HTTP errors are readable and never contain the key', async () => {
    const p = createProvider({ kind: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: KEY }, async () =>
      new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401 })
    )
    const err = await complete(p, [{ role: 'user', content: 'x' }]).catch((e: Error) => e)
    expect(String(err)).toContain('HTTP 401')
    expect(String(err)).toContain('check the API key')
    expect(String(err)).not.toContain(KEY)
  })
})

describe('Anthropic provider', () => {
  test('system goes top-level, x-api-key header, text deltas streamed', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const p = createProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x', apiKey: KEY }, async (url, init) => {
      seen = { url, init }
      return sse([
        `event: message_start\ndata: {"type":"message_start"}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'K' } })}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`
      ])
    })
    expect(await complete(p, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }])).toBe('OK')
    expect(seen!.url).toBe('https://api.anthropic.com/v1/messages')
    const h = seen!.init.headers as Record<string, string>
    expect(h['x-api-key']).toBe(KEY)
    expect(h['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(String(seen!.init.body))
    expect(body.system).toBe('sys')
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }])
  })
})

describe('model config → request body', () => {
  const msgs = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hello', images: [{ mime: 'image/png', data: 'iVBORw0K' }] }
  ]
  const base = { kind: 'openai' as const, baseUrl: 'http://nas:4000/v1', apiKey: null }

  test('nothing known: as before (no max_tokens, no reasoning, temperature, images dropped)', () => {
    const b = openAIBody({ ...base, model: 'm' }, msgs)
    expect(b).toEqual({ model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }], stream: true, temperature: 0.2 })
  })

  test('limits → max_tokens clamped to the window; reasoning → reasoning_effort without temperature', () => {
    const b = openAIBody(
      { ...base, model: 'm', models: [{ id: 'm', contextWindow: 1000, maxOutputTokens: 4096, reasoning: 'high' }] },
      [{ role: 'user', content: 'x'.repeat(400) }]
    )
    expect(b.max_tokens).toBe(1000 - 100 - 256)
    expect(b.reasoning_effort).toBe('high')
    expect(b.temperature).toBeUndefined()
  })

  test('api.openai.com gets max_completion_tokens', () => {
    const b = openAIBody({ ...base, baseUrl: 'https://api.openai.com/v1', model: 'o4-mini', models: [{ id: 'o4-mini', maxOutputTokens: 100_000 }] }, [
      { role: 'user', content: 'hi' }
    ])
    expect(b.max_completion_tokens).toBe(100_000)
    expect(b.max_tokens).toBeUndefined()
  })

  test('vision model: images become image_url parts', () => {
    const b = openAIBody({ ...base, model: 'v', models: [{ id: 'v', input: ['text', 'image'] }] }, msgs)
    expect((b.messages as unknown[])[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } }
      ]
    })
  })

  test('per-run model picks its own config', () => {
    const cfg = { ...base, model: 'a', models: [{ id: 'a', maxOutputTokens: 100 }, { id: 'b', maxOutputTokens: 200 }] }
    expect(openAIBody(cfg, [{ role: 'user', content: 'x' }], { model: 'b' })).toMatchObject({ model: 'b', max_tokens: 200 })
    expect(modelFor(cfg, { model: 'unknown' })).toEqual({ id: 'unknown' })
  })

  test('Anthropic: max_tokens from the model (8192 when unknown), thinking budget for a reasoning level', () => {
    const a = { kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', apiKey: null }
    expect(anthropicBody({ ...a, model: 'c' }, [{ role: 'user', content: 'x' }])).toMatchObject({ max_tokens: 8192, temperature: 0.2 })
    const t = anthropicBody({ ...a, model: 'c', models: [{ id: 'c', contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: 'medium' }] }, [
      { role: 'user', content: 'x' }
    ])
    expect(t).toMatchObject({ max_tokens: 64_000, thinking: { type: 'enabled', budget_tokens: 8192 } })
    expect(t.temperature).toBeUndefined()
    // A small output limit still leaves budget_tokens < max_tokens (and ≥ 1024).
    const small = anthropicBody({ ...a, model: 'c', models: [{ id: 'c', maxOutputTokens: 4096, reasoning: 'high' }] }, [{ role: 'user', content: 'x' }])
    expect(small.max_tokens).toBe(4096)
    expect((small.thinking as { budget_tokens: number }).budget_tokens).toBe(3072)
    expect(thinkingBudget('5000')).toBe(5000)
  })

  test('Anthropic vision: base64 image blocks before the text', () => {
    const b = anthropicBody({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: null, model: 'c', models: [{ id: 'c', input: ['text', 'image'] }] }, msgs)
    expect(b.system).toBe('sys')
    expect((b.messages as unknown[])[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
        { type: 'text', text: 'hello' }
      ]
    })
  })
})
