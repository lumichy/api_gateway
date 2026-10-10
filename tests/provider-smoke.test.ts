import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('provider smoke program runs sequentially, uses first models and retains failures and answers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-smoke-test-'));
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    calls.push(body);
    assert.equal(req.headers.authorization, 'Bearer fixture-gateway-key');
    res.setHeader('content-type', 'application/json');
    if (body.model === 'first/m') {
      res.writeHead(429);
      res.end(JSON.stringify({ error: { code: 'quota_exhausted', message: 'No quota' } }));
    } else {
      res.setHeader('x-gateway-provider', 'second');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { content: '测试介绍' }, finish_reason: 'stop' }],
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const config = join(directory, 'config.json'),
      output = join(directory, 'results.json');
    await writeFile(
      config,
      JSON.stringify({
        port: (server.address() as any).port,
        providers: [
          { id: 'first', type: 'demo', models: ['m', 'unused'] },
          { id: 'disabled', type: 'demo', models: ['m'], enabled: false },
          { id: 'second', type: 'demo', models: ['m'] },
        ],
      }),
    );
    const child = spawn(
      process.execPath,
      ['scripts/test-providers.ts', '--config', config, '--output', output],
      { env: { ...process.env, GATEWAY_KEY: 'fixture-gateway-key' }, windowsHide: true },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    const code = await new Promise<number | null>((r) => child.on('close', r));
    assert.equal(code, 1, stderr);
    assert.deepEqual(
      calls.map((c) => c.model),
      ['first/m', 'second/m'],
    );
    assert(
      calls.every(
        (c) => c.messages[0].content === '请简单介绍一下你自己的大模型。' && c.stream === false,
      ),
    );
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.results[0].error.code, 'quota_exhausted');
    assert.equal(report.results[1].answer, '测试介绍');
    assert(stdout.includes('测试介绍'));
    assert(!stdout.includes('fixture-gateway-key'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
