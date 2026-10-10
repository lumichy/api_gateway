import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProvider } from '../src/adapters/index.ts';
import { createGateway, validateRequest } from '../src/server.ts';
import { State } from '../src/state.ts';
import { Router } from '../src/scheduler.ts';
import { compatibleResponse } from '../src/adapters/compatible-response.ts';
import { requestTokenBudget } from '../src/chat-request.ts';

const tool = {
  type: 'function',
  function: {
    name: 'weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};
const call = {
  id: 'call_1',
  type: 'function',
  function: { name: 'weather', arguments: '{"city":"Tokyo"}' },
};
const usage = {
  prompt_tokens: 4,
  completion_tokens: 6,
  total_tokens: 10,
  completion_tokens_details: { reasoning_tokens: 2 },
};
const completion = {
  id: 'upstream-id',
  object: 'chat.completion',
  created: 10,
  model: 'vendor/m',
  system_fingerprint: 'fp',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [call],
        reasoning_content: 'thinking',
      },
      finish_reason: 'tool_calls',
      logprobs: null,
    },
    {
      index: 1,
      message: { role: 'assistant', content: 'alternative', annotations: [] },
      finish_reason: 'stop',
    },
  ],
  usage,
  vendor_extra: { preserved: true },
};
async function fixture(handler: (body: any, res: any) => void, extras: any[] = []) {
  process.env.FEATURE_TEST_API_KEY = 'fixture-key';
  const seen: any[] = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const parsed = JSON.parse(body);
    seen.push(parsed);
    handler(parsed, res);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const api = createProvider({
    id: 'api',
    type: 'openai-compatible',
    models: ['vendor/m'],
    enabled: true,
    billingVerified: true,
    allowAuto: true,
    priority: 20,
    baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
    apiKeyEnv: 'FEATURE_TEST_API_KEY',
  });
  const state = new State(':memory:');
  const server = createGateway({
    providers: [...extras, api],
    state,
    gatewayKey: 'feature-gateway-key',
    adminKey: 'feature-admin-key',
    timeoutMs: 3000,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    api,
    state,
    async send(body: any) {
      return fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer feature-gateway-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    },
    async close() {
      server.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => upstream.close(() => r())),
      ]);
      state.close();
    },
  };
}
test('native JSON preserves parameters, multiple choices, tool-only output and detailed usage', async () => {
  const f = await fixture((_b, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(completion));
  });
  try {
    const request = {
      model: 'api/vendor/m',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'weather?' },
            { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
          ],
        },
      ],
      tools: [tool],
      tool_choice: 'required',
      parallel_tool_calls: true,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      top_p: 0.8,
      max_completion_tokens: 100,
      n: 2,
      reasoning: { effort: 'low' },
      vendor_option: { enabled: true },
      stream: false,
    };
    const res = await f.send(request);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ...completion, model: request.model });
    assert.deepEqual(f.seen[0], { ...request, model: 'vendor/m' });
    assert.equal(f.state.status().leases.length, 0);
  } finally {
    await f.close();
  }
});
test('tool result and assistant tool-call history is forwarded without flattening', async () => {
  const f = await fixture((_b, res) => res.end(JSON.stringify(completion)));
  try {
    const messages = [
      { role: 'user', content: 'weather' },
      { role: 'assistant', content: null, tool_calls: [call], reasoning: 'retained' },
      { role: 'tool', content: '{"temperature":20}', tool_call_id: 'call_1', name: 'weather' },
    ];
    assert.equal((await f.send({ model: 'api/vendor/m', messages, tools: [tool] })).status, 200);
    assert.deepEqual(f.seen[0].messages, messages);
  } finally {
    await f.close();
  }
});
test('stream preserves fragmented parallel tools, reasoning, choices, finish reasons and usage', async () => {
  const chunks = [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            reasoning_content: 'think',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":' },
              },
              {
                index: 1,
                id: 'call_2',
                type: 'function',
                function: { name: 'weather', arguments: '{' },
              },
            ],
          },
          finish_reason: null,
        },
        { index: 1, delta: { content: 'second' }, finish_reason: null },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '"Tokyo"}' } },
              { index: 1, function: { arguments: '"city":"Osaka"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
        { index: 1, delta: {}, finish_reason: 'content_filter' },
      ],
    },
    { choices: [], usage, vendor_extra: true },
  ].map((body) => ({
    id: 'stream-id',
    object: 'chat.completion.chunk',
    model: 'vendor/m',
    created: 10,
    ...body,
  }));
  const f = await fixture((_b, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  try {
    const res = await f.send({
      model: 'api/vendor/m',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [tool],
      stream: true,
      stream_options: { include_usage: true },
      n: 2,
    });
    assert.equal(res.status, 200);
    const frames = (await res.text())
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => frame.replace(/^data: /, ''));
    assert.equal(frames.pop(), '[DONE]');
    assert.deepEqual(
      frames.map((s) => JSON.parse(s)),
      chunks.map((c) => ({ ...c, model: 'api/vendor/m' })),
    );
    assert.equal(f.seen[0].stream, true);
  } finally {
    await f.close();
  }
});
test('extended auto request excludes CLI before health and invokes compatible API', async () => {
  const cli = createProvider({
    id: 'cli',
    type: 'claude',
    models: ['sonnet'],
    enabled: true,
    billingVerified: true,
    priority: 0,
  });
  let probes = 0;
  cli.health = async () => {
    probes++;
    return { available: true };
  };
  const f = await fixture((_b, res) => res.end(JSON.stringify(completion)), [cli]);
  try {
    assert.equal(
      (await f.send({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], tools: [tool] }))
        .status,
      200,
    );
    const res = await f.send({
      model: 'cli/sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'unsupported');
    assert.equal(probes, 0);
  } finally {
    await f.close();
  }
});
test('budget and message skeleton validation rejects malformed requests', () => {
  for (const extra of [
    { n: 0 },
    { n: 1.5 },
    { max_tokens: -1 },
    { max_completion_tokens: '100' },
    { stream: 'true' },
    { messages: [{ role: 'tool', content: 'x' }] },
    { messages: [{ role: 'user', content: 123 }] },
  ])
    assert.throws(
      () =>
        validateRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...extra }),
      { kind: 'invalid_request' },
    );
});
test('tool delta commits the stream and prevents cross-provider fallback on error', async () => {
  const a = createProvider({ id: 'a', type: 'demo', models: ['m'] });
  const b = createProvider({ id: 'b', type: 'demo', models: ['m'] });
  a.capabilities.chat = true;
  let calls = 0;
  b.invoke = async function* () {
    calls++;
    yield { type: 'done' };
  };
  a.invoke = async function* () {
    yield {
      type: 'chat_chunk',
      body: {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null },
        ],
      },
    };
    throw new Error('failed');
  };
  const state = new State(':memory:');
  try {
    const seen: any[] = [];
    await assert.rejects(async () => {
      for await (const e of new Router([a, b], state).run({
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }))
        seen.push(e);
    });
    assert.equal(seen[0]?.type, 'chat_chunk');
    assert.equal(calls, 0);
    assert.equal(state.status().leases.length, 0);
  } finally {
    state.close();
  }
});
test('requested output tokens and n are included in reservations', () => {
  const request = validateRequest({
    model: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [tool],
    n: 3,
    max_completion_tokens: 200,
  });
  assert.equal(requestTokenBudget(request, 4096), Buffer.byteLength(JSON.stringify(request)) + 600);
});
test('all text adapters reject extended requests before any CLI or HTTP I/O', () => {
  for (const type of ['claude', 'codebuddy', 'codex', 'antigravity', 'demo'] as const) {
    const p = createProvider({
      id: type,
      type,
      mode: type === 'codex' ? 'exec' : undefined,
      models: ['m'],
      enabled: true,
      billingVerified: true,
    });
    for (const extra of [
      { tools: [] },
      { response_format: { type: 'json_object' } },
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    ])
      assert.throws(
        () =>
          p.validate!({
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            ...extra,
          }),
        { kind: 'unsupported' },
      );
  }
});
test('JSON error envelopes and SSE errors retain quota/auth/rate classifications', async () => {
  for (const stream of [false, true])
    for (const [code, kind] of [
      [402, 'quota_exhausted'],
      [401, 'auth_required'],
      [429, 'rate_limited'],
    ] as const) {
      const error = { error: { code } };
      const body = stream ? `data: ${JSON.stringify(error)}\n\n` : JSON.stringify(error);
      await assert.rejects(
        () =>
          Array.fromAsync(
            compatibleResponse(new Response(body), stream, new AbortController().signal),
          ),
        { kind },
      );
    }
});
test('invalid and incomplete responses never succeed, and malformed usage is omitted', async () => {
  for (const body of [
    '{}',
    '{"choices":[]}',
    '{"choices":[{"index":0,"message":null}]}',
    'invalid',
  ])
    await assert.rejects(
      () =>
        Array.fromAsync(
          compatibleResponse(new Response(body), false, new AbortController().signal),
        ),
      { kind: 'transient' },
    );
  for (const body of [
    'data: [DONE]\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"truncated"}}]}\n\ndata: [DONE]\n\n',
  ])
    await assert.rejects(
      () =>
        Array.fromAsync(compatibleResponse(new Response(body), true, new AbortController().signal)),
      { kind: 'transient' },
    );
  const events = await Array.fromAsync(
    compatibleResponse(
      new Response(
        JSON.stringify({
          ...completion,
          usage: { prompt_tokens: 1, completion_tokens: -1, total_tokens: 0 },
        }),
      ),
      false,
      new AbortController().signal,
    ),
  );
  assert.equal('usage' in (events[0] as any).body, false);
});
test('JSON response reading is bounded and cancellation releases an active body', async () => {
  let cancelled = false;
  const oversized = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    () =>
      Array.fromAsync(
        compatibleResponse(new Response(oversized), false, new AbortController().signal),
      ),
    { kind: 'transient' },
  );
  assert.equal(cancelled, true);
  const control = new AbortController();
  const pending = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      cancelled = true;
    },
  });
  cancelled = false;
  const result = Array.fromAsync(compatibleResponse(new Response(pending), false, control.signal));
  setTimeout(() => control.abort(), 10);
  await assert.rejects(() => result, { kind: 'cancelled' });
  assert.equal(cancelled, true);
});
test('standard usage null is preserved in streamed chunks without inventing accounting', async () => {
  const body = {
    choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
    usage: null,
  };
  const events = await Array.fromAsync(
    compatibleResponse(
      new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`),
      true,
      new AbortController().signal,
    ),
  );
  assert.deepEqual(events, [{ type: 'chat_chunk', body }, { type: 'done' }]);
});
