import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

const helper = await import('../scripts/codebuddy.ts').catch(() => undefined);
async function fixture(bin: unknown = { codebuddy: 'bin/codebuddy' }) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-codebuddy-test-'));
  const packageRoot = join(root, '.tools/codebuddy/node_modules/@tencent-ai/codebuddy-code');
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@tencent-ai/codebuddy-code', version: '2.161.0', bin }));
  await writeFile(join(packageRoot, 'bin/codebuddy'), '#!/usr/bin/env node\nconsole.log("2.161.0");\n');
  return { root, packageRoot };
}

test('official extensionless Node entry is resolved from npm manifest', async () => {
  assert.ok(helper, 'CodeBuddy setup helper must exist');
  const f = await fixture();
  try {
    const info = await helper.resolveCodeBuddyInstallation(f.root);
    assert.equal(info.entry, join(f.packageRoot, 'bin/codebuddy'));
    assert.equal(info.version, '2.161.0');
    assert.ok(isAbsolute(info.entry));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('manifest traversal and invalid bin definitions are rejected', async () => {
  assert.ok(helper, 'CodeBuddy setup helper must exist');
  for (const bin of [{ codebuddy: '../outside' }, { codebuddy: 'C:\\outside\\entry.js' }, {}, { codebuddy: 42 }]) {
    const f = await fixture(bin);
    try { await assert.rejects(helper.resolveCodeBuddyInstallation(f.root)); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('generated config is disabled and uses absolute Node plus one official script argument', async () => {
  assert.ok(helper, 'CodeBuddy setup helper must exist');
  const f = await fixture();
  try {
    const prepared = await helper.prepareCodeBuddy(f.root, process.execPath);
    assert.equal(prepared.created, true);
    const config = JSON.parse(await readFile(prepared.configPath, 'utf8'));
    assert.equal(config.providers.length, 1);
    assert.deepEqual(config.providers[0].models, ['hy3']);
    assert.equal(config.providers[0].enabled, false);
    assert.equal(config.providers[0].billingVerified, false);
    assert.equal(config.providers[0].command, process.execPath);
    assert.deepEqual(config.providers[0].args, [join(f.packageRoot, 'bin/codebuddy')]);
    const args = helper.codeBuddyLoginArgs(join(f.packageRoot, 'bin/codebuddy'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.ok(args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true });
    assert.ok(args.includes('--no-session-persistence'));
    const selected=JSON.parse(args[args.indexOf('--agents')+1]);
    assert.deepEqual(selected['gateway-text'].tools,[]);
    assert.ok(args.includes('Read')&&args.includes('MessageColleague'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('existing CodeBuddy config is preserved byte for byte', async () => {
  assert.ok(helper, 'CodeBuddy setup helper must exist');
  const f = await fixture();
  try {
    const configPath = join(f.root, 'config.local.json');
    const original = '{"custom":"preserve me"}\n';
    await writeFile(configPath, original);
    assert.equal((await helper.prepareCodeBuddy(f.root, process.execPath)).created, false);
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
