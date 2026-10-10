import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeQuotaTelemetry } from '../src/adapters/claude-quota.ts';
import { State } from '../src/state.ts';
import { quotaScore } from '../src/quota.ts';

test('new observations persist even when another window is older, without refreshing its freshness', () => {
  const original=Date.now;const start=original();let now=start;Date.now=()=>now;
  const telemetry=createClaudeQuotaTelemetry();const s=new State(':memory:');
  const info=(type:string,utilization:number)=>({type:'rate_limit_event',rate_limit_info:{status:'allowed',rateLimitType:type,utilization,resetsAt:(start+3600000)/1000}});
  try {
    telemetry.observe(info('five_hour',.9),'sonnet');s.saveQuota('claude','sonnet',telemetry.read('sonnet'));
    now=start+61000;telemetry.observe(info('seven_day',.2),'sonnet');
    const q=telemetry.read('sonnet');s.saveQuota('claude','sonnet',q);
    assert.equal(s.getQuota('claude','sonnet')?.windows.length,2);
    assert.equal(quotaScore(q,now,60000),.8);
    now++;telemetry.observe(info('seven_day',1),'sonnet');
    s.saveQuota('claude','sonnet',telemetry.read('sonnet'));
    assert.equal(s.getQuota('claude','sonnet')?.windows.find(w=>w.name==='seven_day')?.remaining,0);
  }finally{Date.now=original;s.close();}
});
import { printCliInvoke } from '../src/adapters/cli-stream.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const event = (rateLimitType: string, utilization?: unknown, resetsAt = Date.now() / 1000 + 3600, status = 'allowed') => ({
  type: 'rate_limit_event', rate_limit_info: { status, rateLimitType, utilization, resetsAt },
});

test('verified CLI 2.1.296 unifiedWindows carries usage even without top-level utilization', () => {
  const telemetry=createClaudeQuotaTelemetry();const reset=Math.floor(Date.now()/1000)+3600;
  telemetry.observe({type:'rate_limit_event',rate_limit_info:{status:'allowed',rateLimitType:'five_hour',
    resetsAt:reset,overageStatus:'rejected',isUsingOverage:false,
    unifiedWindows:{five_hour:{utilization:.01,resetsAt:reset},seven_day:{utilization:.09,resetsAt:reset+86400}}}},'sonnet');
  const q=telemetry.read('sonnet');
  assert.equal(q.source,'official');assert.equal(q.pool,'claude-common');
  assert.deepEqual(q.windows.map(w=>[w.name,w.remaining,w.resetAt]),[['five_hour',99,reset*1000],['seven_day',91,(reset+86400)*1000]]);
  assert.equal(quotaScore(q),.91);
});

test('unified windows preserve family scope and reject invalid values and overage', () => {
  const reset=Math.floor(Date.now()/1000)+3600;const telemetry=createClaudeQuotaTelemetry();
  telemetry.observe({type:'rate_limit_event',rate_limit_info:{status:'allowed',rateLimitType:'five_hour',resetsAt:reset,
    unifiedWindows:{five_hour:{utilization:.1,resetsAt:reset},seven_day:{utilization:'0.3',resetsAt:reset},
      seven_day_opus:{utilization:.9,resetsAt:reset},seven_day_sonnet:{utilization:1,resetsAt:reset},
      overage:{utilization:0,resetsAt:reset}}}},'sonnet');
  assert.deepEqual(telemetry.read('sonnet').windows.map(w=>w.name),['five_hour','seven_day_sonnet']);
  assert.equal(quotaScore(telemetry.read('sonnet')),0);
  assert.deepEqual(telemetry.read('opus').windows.map(w=>w.name),['five_hour']);
});

test('Claude quota is unknown until an official numeric usage event is observed', () => {
  const telemetry = createClaudeQuotaTelemetry();
  assert.equal(telemetry.read('sonnet').source, 'unknown');
  telemetry.observe(event('five_hour'), 'sonnet');
  assert.equal(telemetry.read('sonnet').source, 'unknown');
  telemetry.observe(event('five_hour', .4), 'sonnet');
  const snapshot = telemetry.read('sonnet');
  assert.equal(snapshot.source, 'official');
  assert.equal(snapshot.windows[0].remaining, 60);
  assert.match(snapshot.detail!, /partial/i);
});

test('Claude combines applicable account windows without refreshing older observations', (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const telemetry = createClaudeQuotaTelemetry();
  telemetry.observe(event('five_hour', .1), 'sonnet');
  now += 5000;
  telemetry.observe(event('seven_day', .25), 'opus');
  now += 5000;
  telemetry.observe(event('seven_day_sonnet', .8), 'sonnet');
  const snapshot = telemetry.read('claude-sonnet-4-6');
  assert.equal(snapshot.observedAt, now);
  assert.equal(snapshot.windows[0].observedAt, now - 10000);
  assert.equal(snapshot.pool, 'claude-sonnet');
  assert.deepEqual(snapshot.windows.map(w => w.name), ['five_hour', 'seven_day', 'seven_day_sonnet']);
  assert.deepEqual(telemetry.read('opus').windows.map(w => w.name), ['five_hour', 'seven_day']);
  now += 4000000;
  assert.equal(telemetry.read('sonnet').source, 'unknown');
});

test('Claude ignores overage and unsupported fields and never assumes missing utilization is zero', () => {
  const telemetry = createClaudeQuotaTelemetry();
  for (const candidate of [event('overage', .1), event('new_limit', .1), event('five_hour', '0.1'),
    event('five_hour', NaN), event('five_hour', -1), event('five_hour', 1.01),
    event('five_hour', .1, -1), event('five_hour', .1, Infinity), event('five_hour', .1, undefined, 'bogus'),
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: .1, resetsAt: Date.now() / 1000 + 3600 } } } }]) {
    telemetry.observe(candidate, 'sonnet');
    assert.equal(telemetry.read('sonnet').source, 'unknown');
  }
  telemetry.observe(event('five_hour', .2), 'sonnet');
  telemetry.observe(event('five_hour'), 'sonnet');
  assert.equal(telemetry.read('sonnet').source, 'unknown');
});

test('Claude rejection is an exhausted window only with an official type and future reset', () => {
  const telemetry = createClaudeQuotaTelemetry();
  telemetry.observe(event('seven_day_sonnet', undefined, undefined, 'rejected'), 'sonnet');
  assert.equal(telemetry.read('sonnet').windows[0].remaining, 0);
  assert.equal(telemetry.read('opus').source, 'unknown');
  telemetry.observe(event('five_hour', undefined, -1, 'rejected'), 'sonnet');
  assert.equal(telemetry.read('opus').source, 'unknown');
});

test('print CLI observation runs after initialization and tool validation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'quota-observer-'));
  const fixture = join(folder, 'events.mjs');
  const config = { id: 'claude', type: 'claude' as const, models: ['sonnet'], command: process.execPath, args: [fixture] };
  const request = { model: 'sonnet', messages: [{ role: 'user' as const, content: 'unused' }], stream: false };
  try {
    for (const events of [
      [event('five_hour', .5)],
      [{ type: 'system', subtype: 'init', tools: ['Bash'] }, event('five_hour', .5)],
      [{ type: 'system', subtype: 'init', tools: [] }, { type: 'assistant', message: { content: [{ type: 'tool_use' }] } }],
      [{ type: 'system', subtype: 'init', tools: [] }, event('five_hour', .5), { type: 'result', subtype: 'success', result: 'OK' }],
    ]) {
      await writeFile(fixture, `for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));`);
      const observed: unknown[] = [];
      const pending = () => Array.fromAsync(printCliInvoke(config, request, new AbortController().signal, {
        command: process.execPath, args: () => [fixture], observeEvent: e => observed.push(e),
      }));
      if (events.at(-1)?.type === 'result') {
        await pending(); assert.equal(observed.length, 3);
      } else {
        await assert.rejects(pending);
        assert.equal(observed.length, events[0].type === 'system' && !(events[0] as any).tools.length ? 1 : 0);
      }
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
