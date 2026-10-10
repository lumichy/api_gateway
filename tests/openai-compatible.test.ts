import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProvider } from '../src/adapters/index.ts';
import { validateConfig } from '../src/config.ts';
import { Router } from '../src/scheduler.ts';
import { State } from '../src/state.ts';
import { httpError, openAIStream } from '../src/adapters/http.ts';
import { createGateway } from '../src/server.ts';

const entry = {
  id: 'api',
  type: 'openai-compatible',
  models: ['vendor/model'],
  baseUrl: 'https://example.com/v1',
  apiKeyEnv: 'GATEWAY_TEST_API_KEY',
  enabled: true,
  billingVerified: true,
} as const;
test('numeric OpenRouter SSE error codes preserve billing and authentication classification', async () => {
  for (const [code, kind] of [
    [402, 'quota_exhausted'],
    [401, 'auth_required'],
    [429, 'rate_limited'],
  ] as const) {
    await assert.rejects(
      () =>
        Array.fromAsync(
          openAIStream(
            new Response(`data: ${JSON.stringify({ error: { code } })}\n\n`),
            new AbortController().signal,
          ),
        ),
      { kind },
    );
  }
  await assert.rejects(
    () =>
      Array.fromAsync(
        openAIStream(
          new Response(
            'data: {"error":{"code":402,"metadata":{"limit_source":"openrouter_in_flight_budget"}}}\n\n',
          ),
          new AbortController().signal,
        ),
      ),
    { kind: 'rate_limited' },
  );
});
test('gateway publishes slash aliases and falls back from exhausted opt-in API before output', async () => {
  process.env.GATEWAY_TEST_API_KEY = 'fixture-secret';
  let exhausted = false,
    upstreamCalls = 0;
  const upstream = createServer((_req, res) => {
    upstreamCalls++;
    if (exhausted) {
      res.writeHead(402);
      res.end('{"error":{"code":402}}');
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"API"}}]}\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const api = createProvider(
    config({ baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, priority: 0 })
      .providers[0],
  );
  const fallback = createProvider({
    id: 'fallback',
    type: 'demo',
    models: ['m'],
    priority: 100,
    demo: { text: 'FALLBACK' },
  });
  const state = new State(':memory:');
  const server = createGateway({
    providers: [api, fallback],
    state,
    gatewayKey: 'fixture-gateway-key-long',
    adminKey: 'fixture-admin-key-long',
    timeoutMs: 3000,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = {
    authorization: 'Bearer fixture-gateway-key-long',
    'content-type': 'application/json',
  };
  const send = (model: string) =>
    fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });
  try {
    const listed = await (await fetch(base + '/v1/models', { headers })).json();
    assert(listed.data.some((m: any) => m.id === 'api/vendor/model'));
    const explicit = await send('api/vendor/model');
    assert.equal(explicit.status, 200);
    assert.equal((await explicit.json()).choices[0].message.content, 'API');
    assert.equal((await (await send('auto')).json()).choices[0].message.content, 'FALLBACK');
    assert.equal(upstreamCalls, 1);
    api.allowAuto = true;
    exhausted = true;
    assert.equal((await (await send('auto')).json()).choices[0].message.content, 'FALLBACK');
    assert.equal(upstreamCalls, 2);
    assert.equal(state.getBlock('api', 'vendor/model')?.kind, 'quota_exhausted');
    assert.equal(state.status().leases.length, 0);
  } finally {
    for (const listener of [server, upstream]) {
      listener.closeAllConnections();
      await new Promise<void>((r) => listener.close(() => r()));
    }
    state.close();
    delete process.env.GATEWAY_TEST_API_KEY;
  }
});
const config = (overrides = {}) =>
  validateConfig({ providers: [{ ...entry, models: [...entry.models], ...overrides }] });
test('compatible config accepts namespaced models and requires explicit endpoint and key reference', () => {
  assert.equal(config().providers[0].models[0], 'vendor/model');
  for (const overrides of [
    { baseUrl: undefined },
    { apiKeyEnv: undefined },
    { allowAuto: 'yes' },
    { models: ['vendor//model'] },
  ])
    assert.throws(() => config(overrides));
});
test('compatible HTTP preserves upstream model, history, bearer auth and streams text', async () => {
  process.env.GATEWAY_TEST_API_KEY = 'fixture-secret';
  let seen: any;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as any).port;
    const p = createProvider(config({ baseUrl: `http://127.0.0.1:${port}/v1/` }).providers[0]);
    const request = {
      model: 'vendor/model',
      messages: [
        { role: 'user' as const, content: 'first' },
        { role: 'assistant' as const, content: 'reply' },
        { role: 'user' as const, content: 'next' },
      ],
      stream: false,
    };
    assert.equal(p.capabilities.history, true);
    assert.equal((await p.health()).available, true);
    assert.equal((await p.quota(request.model, new AbortController().signal)).source, 'unknown');
    assert.deepEqual(await Array.fromAsync(p.invoke(request, new AbortController().signal)), [
      { type: 'text', text: 'OK' },
      { type: 'done', finishReason: 'stop' },
    ]);
    assert.deepEqual(seen, {
      url: '/v1/chat/completions',
      auth: 'Bearer fixture-secret',
      body: { ...request, stream: true },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.GATEWAY_TEST_API_KEY;
  }
});
test('API is excluded from auto by default but explicit namespaced routing and opt-in work', async () => {
  for (const allowAuto of [undefined, true]) {
    const p = createProvider(config({ allowAuto }).providers[0]);
    p.health = async () => ({ available: true });
    p.invoke = async function* (req) {
      assert.equal(req.model, 'vendor/model');
      yield { type: 'text', text: 'OK' };
      yield { type: 'done' };
    };
    const state = new State(':memory:');
    try {
      const router = new Router([p], state);
      const req = {
        model: 'api/vendor/model',
        messages: [{ role: 'user' as const, content: 'hi' }],
        stream: false,
      };
      assert.equal((await Array.fromAsync(router.run(req)))[0].text, 'OK');
      if (allowAuto)
        assert.equal((await Array.fromAsync(router.run({ ...req, model: 'auto' })))[0].text, 'OK');
      else
        await assert.rejects(() => Array.fromAsync(router.run({ ...req, model: 'auto' })), {
          kind: 'quota_exhausted',
        });
    } finally {
      state.close();
    }
  }
});
test('Ark forwards the configured endpoint and key like every compatible provider', async () => {
  const saved = globalThis.fetch;
  process.env.GATEWAY_TEST_API_KEY = 'fixture-secret';
  let url = '', authorization = '';
  globalThis.fetch = async (input, options) => {
    url = String(input);
    authorization = new Headers(options?.headers).get('authorization') ?? '';
    return new Response('data: [DONE]\n\n');
  };
  try {
    const p = createProvider({
      id: 'ark',
      type: 'openai-compatible',
      baseUrl: 'https://example.com/custom/v1',
      models: ['m'],
      enabled: true,
      billingVerified: true,
      apiKeyEnv: 'GATEWAY_TEST_API_KEY',
    });
    await Array.fromAsync(
      p.invoke(
        { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
        new AbortController().signal,
      ),
    );
    assert.equal(url, 'https://example.com/custom/v1/chat/completions');
    assert.equal(authorization, 'Bearer fixture-secret');
  } finally {
    globalThis.fetch = saved;
    delete process.env.GATEWAY_TEST_API_KEY;
  }
});
test('Ark auto routing uses the same explicit opt-in as other compatible providers', () => {
  const p = config({
    id: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: ['m'],
    allowAuto: true,
  }).providers[0];
  assert.equal(createProvider(p).allowAuto, true);
  assert.equal(createProvider({ ...p, allowAuto: undefined }).allowAuto, false);
  assert.doesNotThrow(() => createProvider({ ...p, baseUrl: 'https://example.com/v1' }));
});
test('payment required is quota exhaustion while in-flight spending limit is retryable', async () => {
  assert.equal(
    (await httpError(new Response('{"error":{"code":402}}', { status: 402 }))).kind,
    'quota_exhausted',
  );
  assert.equal(
    (
      await httpError(
        new Response('{"error":{"metadata":{"limit_source":"openrouter_in_flight_budget"}}}', {
          status: 402,
        }),
      )
    ).kind,
    'rate_limited',
  );
});
