import test from 'node:test';
import assert from 'node:assert/strict';
import { arkQuota, parseArkQuota } from '../src/adapters/ark-quota.ts';

const now = Date.now();
const reset = new Date(now + 3600000).toISOString();
const fixture = () => ({ items: [
  { product: 'agent-plan', subscribed: true, periods: [{ label: 'weekly', percent: 99 }] },
  { product: 'coding-plan', subscribed: true, updated_at: now - 5000, periods: [
    { label: 'monthly', percent: 100, reset_at: reset },
    { label: 'session', percent: .5, reset_at: reset },
    { label: 'weekly', percent: 25 },
  ] },
] });

test('Ark parses only Coding Plan percentage windows and preserves response freshness', () => {
  const result = parseArkQuota(fixture(), now);
  assert.equal(result.source, 'official');
  assert.equal(result.pool, 'ark-coding-plan');
  assert.equal(result.observedAt, now - 5000);
  assert.deepEqual(result.windows.map(w => [w.name, w.remaining, w.resetAt]), [
    ['session', 99.5, Date.parse(reset)], ['weekly', 75, null], ['monthly', 0, Date.parse(reset)],
  ]);
  assert.equal(result.windows[0].unit, 'percent');
  assert.equal(result.windows[0].limit, 100);
});

test('Ark refuses malformed, duplicate, unrelated and unsubscribed quota responses', () => {
  const mutations = [
    (v: any) => { v.items[1].subscribed = false; },
    (v: any) => { v.items[1].error = 'secret authentication failure'; },
    (v: any) => { v.items[1].periods = []; },
    (v: any) => { v.items[1].periods[0].percent = '20'; },
    (v: any) => { v.items[1].periods[0].percent = -1; },
    (v: any) => { v.items[1].periods[0].percent = 101; },
    (v: any) => { v.items[1].periods[0].reset_at = 'broken'; },
    (v: any) => { v.items[1].periods[0].reset_at = new Date(now - 1).toISOString(); },
    (v: any) => { v.items[1].periods[0].label = 'unsupported'; },
    (v: any) => { v.items[1].periods.push(v.items[1].periods[0]); },
    (v: any) => { v.items.push(v.items[1]); },
    (v: any) => { v.items.pop(); },
    (v: any) => { v.items[1].updated_at = now + 1; },
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    const result = parseArkQuota(value, now);
    assert.equal(result.source, 'unknown');
    assert.deepEqual(result.windows, []);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
  assert.equal(parseArkQuota(null, now).source, 'unknown');
});

test('Ark accepts an available subset without fabricating missing periods or timestamps', () => {
  const result = parseArkQuota({ items: [{ product: 'coding-plan', subscribed: true,
    periods: [{ label: 'session', percent: 0 }] }] }, now);
  assert.equal(result.source, 'official');
  assert.equal(result.observedAt, now);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].resetAt, null);
});

test('Ark unavailable native command returns sanitized unknown and propagates cancellation', async () => {
  const config = { id: 'ark', type: 'openai-compatible' as const, models: ['ark-code-latest'],
    quotaCommand: 'gateway-nonexistent-arkcli-secret-command.exe' };
  const result = await arkQuota(config, new AbortController().signal);
  assert.equal(result.source, 'unknown');
  assert.deepEqual(result.windows, []);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.match(result.detail ?? '', /CLI|authentication/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(() => arkQuota(config, cancelled.signal), { kind: 'cancelled' });
});
