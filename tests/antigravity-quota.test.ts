import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityQuota, parseAntigravityQuota } from '../src/adapters/antigravity-quota.ts';

const now = Date.now();
const reset = new Date(now + 3600000).toISOString();
const envelope = () => ({
  conversation_id: '', status: 'SUCCESS', duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: .65, reset_time: reset },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0, reset_time: reset },
    ] },
    { name: 'Claude and GPT models', buckets: [
      { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: reset },
      { id: '3p-5h', window: '5h', remaining_fraction: .9, reset_time: reset },
    ] },
  ] } },
});

test('official quota selects only the requested model family and preserves exhausted windows', () => {
  const gemini = parseAntigravityQuota(envelope(), 'gemini-3.8-flash-low', now);
  assert.equal(gemini.source, 'official');
  assert.equal(gemini.pool, 'gemini');
  assert.deepEqual(gemini.windows.map(w => w.remaining), [65, 0]);
  assert.equal(gemini.windows[0].resetAt, Date.parse(reset));
  const claude = parseAntigravityQuota(envelope(), 'claude-sonnet-4-6', now);
  assert.equal(claude.pool, '3p');
  assert.deepEqual(claude.windows.map(w => w.remaining), [100, 90]);
  assert.equal(parseAntigravityQuota(envelope(), 'gpt-oss-120b', now).pool, '3p');
  assert.equal(parseAntigravityQuota(envelope(), 'new-family', now).source, 'unknown');
});

test('untrusted, stale or partial quota data never becomes an official snapshot', () => {
  const mutations = [
    (v: any) => { v.status = 'ERROR'; },
    (v: any) => { v.num_turns = 1; },
    (v: any) => { v.usage.input_tokens = 1; },
    (v: any) => { v.command.name = 'answer'; },
    (v: any) => { v.command.data.groups[0].buckets.pop(); },
    (v: any) => { v.command.data.groups[0].buckets[0].remaining_fraction = 1.1; },
    (v: any) => { v.command.data.groups[0].buckets[0].remaining_fraction = '0.4'; },
    (v: any) => { v.command.data.groups[0].buckets[0].reset_time = 'broken'; },
    (v: any) => { v.command.data.groups[0].buckets[0].reset_time = new Date(now - 1).toISOString(); },
    (v: any) => { v.command.data.groups.push(v.command.data.groups[0]); },
  ];
  for (const mutate of mutations) {
    const value = envelope(); mutate(value);
    assert.equal(parseAntigravityQuota(value, 'gemini-3.8-flash-low', now).source, 'unknown');
  }
});

test('native read-only command uses an isolated cwd, safe environment and bounded output', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agy-quota-test-'));
  const profile = join(folder, 'profile');
  await mkdir(profile);
  const fixture = join(folder, 'quota.mjs');
  await writeFile(fixture, `import assert from 'node:assert/strict';
    const args = process.argv.slice(2);
    if (args.includes('--version')) { console.log('1.3.3'); process.exit(0); }
    assert.equal(args[args.indexOf('-p') + 1], '/usage');
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    assert.ok(!args.includes('--disable-slash-commands'));
    assert.ok(process.cwd().includes('gateway-agy-quota-'));
    assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    assert.equal(process.env.GEMINI_API_KEY, undefined);
    console.log(JSON.stringify(${JSON.stringify(envelope())}));
  `);
  try {
    const config = { id: 'ag', type: 'antigravity' as const, models: ['gemini-3.8-flash-low'], command: process.execPath, args: [fixture] };
    const result = await antigravityQuota(config, 'gemini-3.8-flash-low', new AbortController().signal, profile);
    assert.equal(result.source, 'official');
    assert.deepEqual(result.windows.map(w => w.remaining), [65, 0]);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(() => antigravityQuota(config, 'gemini-3.8-flash-low', aborted.signal, profile), { kind: 'cancelled' });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

for (const [name, script] of [
  ['unverified version', "if (args.includes('--version')) { console.log('1.3.2'); } else { throw new Error('quota must not run'); }"],
  ['malformed JSON', "if (args.includes('--version')) { console.log('1.3.3'); } else { console.log('not-json secret-value'); }"],
  ['oversized output', "if (args.includes('--version')) { console.log('1.3.3'); } else { console.log('x'.repeat(70000)); }"],
  ['failed CLI', "if (args.includes('--version')) { console.log('1.3.3'); } else { console.error('secret-token authentication failure'); process.exitCode = 1; }"],
] as const) {
  test('native quota safely returns unknown for ' + name, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'agy-quota-failure-'));
    const fixture = join(folder, 'quota.mjs');
    await writeFile(fixture, 'const args = process.argv.slice(2); ' + script);
    try {
      const result = await antigravityQuota({ id: 'ag', type: 'antigravity', models: ['gemini-pro'], command: process.execPath, args: [fixture] },
        'gemini-pro', new AbortController().signal, folder);
      assert.equal(result.source, 'unknown');
      assert.deepEqual(result.windows, []);
      assert.ok(!JSON.stringify(result).includes('secret'));
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}

test('native quota cancellation terminates an active query', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agy-quota-cancel-'));
  const fixture = join(folder, 'quota.mjs');
  await writeFile(fixture, "if (process.argv.includes('--version')) console.log('1.3.3'); else setInterval(() => {}, 1000);");
  const controller = new AbortController();
  try {
    const pending = antigravityQuota({ id: 'ag', type: 'antigravity', models: ['gemini-pro'], command: process.execPath, args: [fixture] },
      'gemini-pro', controller.signal, folder);
    setTimeout(() => controller.abort(), 250);
    await assert.rejects(() => pending, { kind: 'cancelled' });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
