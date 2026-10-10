import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createProvider } from '../src/adapters/index.ts';
import type { ChatRequest } from '../src/types.ts';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  antigravityInvoke,
  antigravityHealth,
  verifyAntigravityProfile,
} from '../src/adapters/antigravity.ts';
import { Router } from '../src/scheduler.ts';
import { State } from '../src/state.ts';
const profile = await mkdtemp(join(tmpdir(), 'gateway-agy-test-profile-'));
test.after(async () => rm(profile, { recursive: true, force: true }));
const fixture = fileURLToPath(new URL('./fixtures/antigravity.mjs', import.meta.url));
const config = {
  id: 'ag',
  type: 'antigravity' as const,
  models: ['m'],
  enabled: true,
  billingVerified: true,
  command: process.execPath,
  args: [fixture],
};
const req = (text: string): ChatRequest => ({
  model: 'm',
  messages: [{ role: 'user', content: text }],
  stream: true,
});
const invoke = (text: string, s = new AbortController().signal) =>
  Array.fromAsync(antigravityInvoke(config, req(text), s, profile));
test('Antigravity accepts verified versions and refuses unverified upgrades', async () => {
  const previous = process.env.GATEWAY_FIXTURE_AGY_VERSION;
  try {
    for (const [version, expected] of [['1.3.1', true], ['1.3.2', true], ['1.3.3', true], ['1.3.4', false], ['2.0.0', false]] as const) {
      process.env.GATEWAY_FIXTURE_AGY_VERSION = version;
      assert.equal((await antigravityHealth(config, new AbortController().signal, profile)).available, expected, version);
      if (!expected) await assert.rejects(() => invoke('OK'), { kind: 'unsupported' });
    }
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_FIXTURE_AGY_VERSION;
    else process.env.GATEWAY_FIXTURE_AGY_VERSION = previous;
  }
});
test('Antigravity integrates selected empty-tool Agent despite global initialization catalog', async () => {
  const p = createProvider(config);
  assert.equal(p.capabilities.system, true);
  assert.equal(p.capabilities.history, false);
  assert.equal(
    (await antigravityHealth(config, new AbortController().signal, profile)).available,
    true,
  );
  assert.deepEqual(await invoke('STREAM'), [
    { type: 'text', text: '你' },
    { type: 'text', text: '好\n' },
    {
      type: 'done',
      finishReason: 'stop',
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  ]);
});
test('Antigravity system and stdin user are kept separate and literal', async () => {
  const request = req('SYSTEM_REPORT');
  request.messages.unshift({ role: 'system', content: 'literal $(unsafe)\n---\nnext' });
  const out = await Array.fromAsync(
    antigravityInvoke(config, request, new AbortController().signal, profile),
  );
  assert.equal(out[0].type === 'text' && out[0].text, 'literal $(unsafe)\n---\nnext');
  const user = 'Hello $(unsafe)\n{"event":"user"}';
  assert.equal((await invoke(user))[0].text, user);
});
for (const [input, kind] of [
  ['TOOL', 'unsupported'],
  ['SUBAGENT', 'unsupported'],
  ['WRONG_MODEL', 'unsupported'],
  ['NO_INIT', 'transient'],
  ['DIVERGE', 'transient'],
  ['EMPTY', 'transient'],
  ['TRAILING', 'transient'],
  ['OVERSIZE', 'transient'],
  ['QUOTA', 'quota_exhausted'],
  ['AUTH', 'auth_required'],
  ['RATE', 'rate_limited'],
  ['FAILED', 'transient'],
  ['EXIT_BAD', 'quota_exhausted'],
]) {
  test('Antigravity rejects ' + input, async () => {
    await assert.rejects(
      () => invoke(input),
      (e: any) => {
        assert.equal(e.kind, kind);
        assert.ok(!e.message.includes('secret-token'));
        return true;
      },
    );
  });
}
test('Antigravity omits invalid upstream usage', async () => {
  assert.equal((await invoke('BAD_USAGE')).at(-1)?.usage, undefined);
});
test('Antigravity cancellation kills subprocess', async () => {
  const c = new AbortController();
  const pending = invoke('WAIT', c.signal);
  setTimeout(() => c.abort(), 150);
  await assert.rejects(() => pending, { kind: 'cancelled' });
});
test('Antigravity rejects history and developer roles before launch', () => {
  const p = createProvider(config);
  const r = req('hi');
  r.messages.unshift({ role: 'developer', content: 'rules' });
  assert.throws(() => p.validate?.(r), { kind: 'unsupported' });
});
for (const settings of [
  { useG1Credits: true },
  { modelProvider: 'gemini' },
  { hooks: { evil: {} } },
]) {
  test('Antigravity refuses unsafe profile ' + JSON.stringify(settings), async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gateway-agy-profile-'));
    try {
      await mkdir(join(folder, 'antigravity-cli'));
      await writeFile(join(folder, 'antigravity-cli/settings.json'), JSON.stringify(settings));
      await assert.rejects(() => verifyAntigravityProfile(folder), { kind: 'unsupported' });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
}
test('Antigravity hooks need explicit approval of their exact configuration', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gateway-agy-hooks-'));
  try {
    await mkdir(join(folder, 'config'));
    const file = join(folder, 'config/hooks.json');
    await writeFile(file, JSON.stringify({ status: { Stop: [{ command: 'status.exe' }] } }));
    await assert.rejects(() => verifyAntigravityProfile(folder), { kind: 'unsupported' });
    const { antigravityHooksDigest } = await import('../src/adapters/antigravity.ts');
    const digest = await antigravityHooksDigest(folder);
    await verifyAntigravityProfile(folder, digest);
    await writeFile(file, JSON.stringify({ status: { Stop: [{ command: 'changed.exe' }] } }));
    await assert.rejects(() => verifyAntigravityProfile(folder, digest), { kind: 'unsupported' });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('Antigravity permits explicitly disabled global hooks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gateway-agy-disabled-hooks-'));
  try {
    await mkdir(join(folder, 'config'));
    await writeFile(
      join(folder, 'config/hooks.json'),
      JSON.stringify({ status: { enabled: false, Stop: [{ command: 'unused.exe' }] } }),
    );
    await verifyAntigravityProfile(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
for (const file of ['AGENTS.md', 'GEMINI.md', 'config/AGENTS.md', 'config/GEMINI.md']) {
  test('Antigravity refuses automatic global instructions ' + file, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'gateway-agy-rules-'));
    try {
      await mkdir(join(folder, 'config'));
      await writeFile(join(folder, file), 'Additional global instruction');
      await assert.rejects(() => verifyAntigravityProfile(folder), { kind: 'unsupported' });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
}
test('Antigravity quota failure uses gateway fallback and releases both leases', async () => {
  const ag = createProvider(config);
  ag.health = (s) => antigravityHealth(config, s ?? new AbortController().signal, profile);
  ag.invoke = (r, s) => antigravityInvoke(config, r, s, profile);
  const next = createProvider({
    id: 'next',
    type: 'demo',
    models: ['m'],
    priority: 200,
    demo: { text: 'fallback' },
  });
  const state = new State(':memory:');
  try {
    const out = await Array.fromAsync(
      new Router([ag, next], state).run({ ...req('QUOTA'), model: 'auto', stream: false }),
    );
    assert.equal(out[0].providerId, 'next');
    assert.equal(out[0].text, 'fallback');
    assert.equal(state.getBlock('ag', 'm')?.kind, 'quota_exhausted');
    assert.equal(state.status().leases.length, 0);
  } finally {
    state.close();
  }
});
