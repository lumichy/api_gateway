import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/adapters/index.ts';
import { validateConfig } from '../src/config.ts';
import { quotaScore } from '../src/quota.ts';

test('explicit OpenRouter telemetry uses the official daily free counter, not dollar usage', async () => {
  const original = globalThis.fetch;
  process.env.QUOTA_TEST_KEY = 'private-test-key';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/key');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-key');
    return Response.json({ data: { limit: 0, limit_remaining: 0, usage_daily: 19,
      free_model_daily_requests: { used: 6, limit: 50, remaining: 44 } } });
  };
  try {
    const p = createProvider({ id: 'router', type: 'openai-compatible', models: ['openrouter/free'],
      baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'QUOTA_TEST_KEY', enabled: true,
      billingVerified: true, quotaSource: 'openrouter' } as any);
    const q = await p.quota('openrouter/free', new AbortController().signal);
    assert.equal(q.source, 'official');
    assert.equal(q.windows[0].unit, 'requests');
    assert.equal(q.windows[0].remaining, 44);
    assert.equal(q.windows[0].limit, 50);
    assert.equal(quotaScore(q), 44 / 50);
    assert.ok(q.windows[0].resetAt! > Date.now());
    assert.equal(q.pool, 'openrouter-free-daily');
  } finally { globalThis.fetch = original; delete process.env.QUOTA_TEST_KEY; }
});

test('unknown telemetry states the reason without guessing a quota', async () => {
  const p = createProvider({ id: 'api', type: 'openai-compatible', models: ['m'],
    baseUrl: 'https://example.com/v1', apiKeyEnv: 'QUOTA_TEST_KEY' });
  const q = await p.quota('m', new AbortController().signal);
  assert.equal(q.source, 'unknown');
  assert.match(q.detail!, /not configured/i);
  assert.deepEqual(q.windows, []);
});

test('quota sources are explicit and validated independently of inference adapters', () => {
  const p = { id: 'router', type: 'openai-compatible', models: ['openrouter/free'],
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'QUOTA_TEST_KEY', quotaSource: 'openrouter' };
  assert.equal(validateConfig({ providers: [p] }).providers[0].quotaSource, 'openrouter');
  assert.throws(() => validateConfig({ providers: [{ ...p, quotaSource: 'made-up' }] }));
  assert.throws(() => validateConfig({ providers: [{ ...p, baseUrl: 'https://example.com/v1' }] }));
});

test('missing, inconsistent and failed free counters remain unknown and do not expose response data', async () => {
  const original = globalThis.fetch;
  process.env.QUOTA_TEST_KEY = 'private-test-key';
  const p = createProvider({ id: 'router', type: 'openai-compatible', models: ['vendor/m:free'],
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'QUOTA_TEST_KEY', enabled: true,
    billingVerified: true, quotaSource: 'openrouter' } as any);
  try {
    for (const data of [{ usage: 0, usage_daily: 0 },
      { usage: 0, free_model_daily_requests: { limit: 50, used: 10, remaining: 49 } },
      { usage: 0, free_model_daily_requests: { limit: 50, used: 10, remaining: '40' } }]) {
      globalThis.fetch = async () => Response.json({data});
      const q = await p.quota('vendor/m:free', new AbortController().signal);
      assert.equal(q.source,'unknown'); assert.deepEqual(q.windows,[]);
      assert.equal(quotaScore(q),null);
    }
    globalThis.fetch = async () => Response.json({error:'private-test-key'}, {status:401});
    const failed = await p.quota('vendor/m:free',new AbortController().signal);
    assert.equal(failed.source,'unknown'); assert.match(failed.detail!,/HTTP 401/);
    assert.ok(!JSON.stringify(failed).includes('private-test-key'));
    globalThis.fetch = async () => {throw Error('private-test-key');};
    assert.ok(!JSON.stringify(await p.quota('vendor/m:free',new AbortController().signal)).includes('private-test-key'));
  } finally {globalThis.fetch=original;delete process.env.QUOTA_TEST_KEY;}
});

test('paid models do not inherit the free-model counter', async () => {
  const original=globalThis.fetch;process.env.QUOTA_TEST_KEY='private-test-key';
  globalThis.fetch=async()=>Response.json({data:{limit:100,limit_remaining:25,usage:75,
    free_model_daily_requests:{used:50,limit:50,remaining:0}}});
  try {
    const p=createProvider({id:'router',type:'openai-compatible',models:['paid'],enabled:true,
      billingVerified:true,baseUrl:'https://openrouter.ai/api/v1',apiKeyEnv:'QUOTA_TEST_KEY',quotaSource:'openrouter'} as any);
    const q=await p.quota('paid',new AbortController().signal);
    assert.equal(q.pool,'openrouter-key-credit');assert.equal(quotaScore(q),0.25);
    assert.equal(q.windows[0].unit,'percent');assert.equal(q.balances?.[0].remaining,25);
  }finally{globalThis.fetch=original;delete process.env.QUOTA_TEST_KEY;}
});
