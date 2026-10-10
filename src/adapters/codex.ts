import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayError } from '../errors.ts';
import { checkAbort } from './http.ts';
import { validateBootstrap, subscriptionEnvironment } from './subprocess.ts';
import type { ProviderConfig } from './index.ts';
import type { QuotaSnapshot, QuotaWindow } from '../types.ts';
export async function codexQuota(
  config: ProviderConfig,
  signal: AbortSignal,
): Promise<QuotaSnapshot> {
  checkAbort(signal);
  validateBootstrap(config);
  const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-quota-'));
  const child = spawn(
    config.command ?? 'codex',
    [
      ...(config.args ?? []),
      '-c',
      'forced_login_method="chatgpt"',
      '-c',
      'model_provider="openai"',
      'app-server',
    ],
    {
      shell: false,
      windowsHide: true,
      cwd: directory,
      env: subscriptionEnvironment('codex'),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let id = 0;
  let buffer = '';
  let failed: GatewayError | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
  const fail = (error: GatewayError) => {
    failed = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const completion = new Promise<void>((resolve) => {
    child.once('error', () => {
      fail(new GatewayError('auth_required', 'Codex app-server unavailable'));
      resolve();
    });
    child.once('close', () => {
      fail(new GatewayError('transient', 'Codex app-server closed'));
      resolve();
    });
  });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 1048576) {
      fail(new GatewayError('transient', 'Codex RPC response too large'));
      child.kill();
      return;
    }
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        fail(new GatewayError('transient', 'Invalid Codex RPC response'));
        child.kill();
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error)
          waiter.reject(new GatewayError('auth_required', 'Codex quota RPC failed'));
        else waiter.resolve(message.result);
      }
      // Reject every server initiated request: quota retrieval never approves tools.
      else if (message.id !== undefined && message.method)
        child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: { code: -32601, message: 'Gateway only supports quota reads' },
          }) + '\n',
        );
    }
  });
  const abort = () => {
    fail(new GatewayError('cancelled', 'Quota request cancelled'));
    child.kill();
  };
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    fail(new GatewayError('transient', 'Codex quota RPC timed out'));
    child.kill();
  }, 10000);
  timeout.unref();
  const ask = (method: string, params?: any) => {
    if (failed) return Promise.reject(failed);
    const next = ++id;
    return new Promise<any>((resolve, reject) => {
      pending.set(next, { resolve, reject });
      child.stdin.write(JSON.stringify({ id: next, method, ...(params ? { params } : {}) }) + '\n');
    });
  };
  try {
    await ask('initialize', { clientInfo: { name: 'subscription-gateway', version: '0.1.0' } });
    checkAbort(signal);
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const result = await ask('account/rateLimits/read');
    checkAbort(signal);
    // Keep the codex bucket only. Other model-specific pools cannot be merged.
    const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
    const windows: QuotaWindow[] = [];
    for (const w of [bucket?.primary, bucket?.secondary])
      if (w && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent))
        windows.push({
          unit: 'percent',
          remaining: Math.max(0, 100 - w.usedPercent),
          usedPercent: w.usedPercent,
          limit: 100,
          resetAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
        });
    return {
      source: windows.length ? 'official' : 'unknown',
      observedAt: Date.now(),
      pool: 'codex-app-server',
      windows,
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    child.kill();
    await completion;
    await rm(directory, { recursive: true, force: true });
  }
}
