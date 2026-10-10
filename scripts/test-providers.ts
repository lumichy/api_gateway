import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';

const prompt = '请简单介绍一下你自己的大模型。';
type Result = {
  provider: string;
  model: string;
  status?: number;
  ok: boolean;
  elapsedMs: number;
  servedBy?: string;
  returnedModel?: string;
  answer?: string;
  finishReason?: string;
  usage?: unknown;
  error?: { code: string; message: string };
};

function options() {
  const values: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i],
      value = process.argv[i + 1];
    if (!['--config', '--output', '--provider'].includes(name) || !value || value.startsWith('--'))
      throw new Error(
        'Usage: node --env-file=.env.local scripts/test-providers.ts [--config config.local.json] [--output data/provider-test-results.json] [--provider ID]',
      );
    values[name] = value;
  }
  return {
    config: values['--config'] ?? 'config.local.json',
    output: resolve(values['--output'] ?? 'data/provider-test-results.json'),
    provider: values['--provider'],
  };
}

async function main() {
  const args = options();
  const config = await loadConfig(args.config);
  const key =
    process.env[config.gatewayKeyEnv] ??
    (config.demoMode ? 'demo-local-gateway-key-12345678' : undefined);
  if (!key)
    throw new Error(
      `Missing ${config.gatewayKeyEnv}; load the private environment file with --env-file=.env.local`,
    );
  const base = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
  const providers = config.providers.filter(
    (p) =>
      p.enabled &&
      (p.type === 'demo' || p.billingVerified) &&
      (!args.provider || args.provider === p.id),
  );
  if (!providers.length) throw new Error('No matching enabled providers');
  const results: Result[] = [];
  const startedAt = new Date().toISOString();
  console.log(`提示词：${prompt}\n网关：${base}/v1\n依次测试 ${providers.length} 个 provider。`);
  for (const provider of providers) {
    const model = provider.id + '/' + provider.models[0];
    console.log(`\n--- ${provider.id} | ${model} ---`);
    const started = Date.now();
    const result: Result = { provider: provider.id, model, ok: false, elapsedMs: 0 };
    try {
      const response = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
        signal: AbortSignal.timeout(config.timeoutMs + 10000),
      });
      result.status = response.status;
      result.servedBy = response.headers.get('x-gateway-provider') ?? undefined;
      const body = await response.json();
      if (!response.ok || body.error) {
        result.error = {
          code: String(body.error?.code ?? 'http_error'),
          message: String(body.error?.message ?? `HTTP ${response.status}`),
        };
      } else {
        const choice = body.choices?.[0];
        if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim())
          throw new Error('Gateway returned no text answer');
        result.answer = choice.message.content;
        result.returnedModel = body.model;
        result.finishReason = choice.finish_reason;
        result.usage = body.usage;
        result.ok = true;
      }
    } catch (error) {
      result.error = {
        code:
          error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'timeout'
            : 'request_failed',
        message: error instanceof Error ? error.message : 'Request failed',
      };
    }
    result.elapsedMs = Date.now() - started;
    console.log(`状态：${result.status ?? '请求失败'}；耗时：${result.elapsedMs} ms`);
    console.log(
      result.ok ? result.answer : `错误：${result.error?.code} — ${result.error?.message}`,
    );
    results.push(result);
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(
      args.output,
      JSON.stringify({ startedAt, prompt, gateway: base + '/v1', results }, null, 2) + '\n',
    );
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n完成：${passed}/${results.length} 成功。完整结果：${args.output}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Provider test failed');
  process.exitCode = 1;
});
