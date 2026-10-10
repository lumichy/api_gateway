import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('doctor reports configuration without exposing or requiring secret values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-doctor-test-'));
  try {
    const config = JSON.parse(readFileSync('config.example.json', 'utf8'));
    // Keep diagnostics independent of local enablement, credentials and CLI logins.
    config.providers = config.providers.map(provider => ({...provider, enabled: false}));
    const path = join(directory, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    const result = spawnSync(process.execPath, ['scripts/doctor.ts', '--config', path], {
      encoding: 'utf8', cwd: process.cwd(),
      env: {...process.env, GATEWAY_KEY: 'do-not-display-sensitive-value'},
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.providers.map(provider => provider.id), config.providers.map(provider => provider.id));
    for (const provider of data.providers) {
      assert.equal(provider.enabled, false);
      assert.equal(provider.available, false);
      assert.equal(provider.liveVerified, false);
    }
    assert.ok(!result.stdout.includes('do-not-display-sensitive-value'));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
test('real start fails clearly before provider calls when gateway keys are missing',()=>{const env={...process.env};delete env.GATEWAY_KEY;delete env.GATEWAY_ADMIN_KEY;const r=spawnSync(process.execPath,['src/main.ts','--config','config.example.json'],{encoding:'utf8',env});assert.equal(r.status,1);assert.match(r.stderr,/distinct GATEWAY_KEY/);});
