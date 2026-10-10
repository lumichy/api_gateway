import type { QuotaSnapshot } from '../types.ts';
import type { ProviderConfig } from './index.ts';
import { checkAbort } from './http.ts';

export function unknownQuota(detail: string): QuotaSnapshot {
  return { source: 'unknown', observedAt: Date.now(), windows: [], detail };
}

const nonnegative = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

export async function openrouterQuota(
  config: ProviderConfig,
  model: string,
  signal: AbortSignal,
): Promise<QuotaSnapshot> {
  checkAbort(signal);
  // Credential destinations are fixed by the explicit telemetry source, never redirects.
  if (config.baseUrl !== 'https://openrouter.ai/api/v1')
    return unknownQuota('OpenRouter telemetry requires its official API baseUrl');
  const key = config.apiKeyEnv && process.env[config.apiKeyEnv];
  if (!key) return unknownQuota('Quota query credential is missing');
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unknownQuota('Official quota query returned HTTP ' + response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) return unknownQuota('Official quota response is empty');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) return unknownQuota('Official quota response exceeds size limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const d = JSON.parse(Buffer.concat(chunks).toString('utf8')).data;
    if (!d || !nonnegative(d.usage)) {
      // Some official responses omit optional usage, but a daily counter remains sufficient.
      if (!d?.free_model_daily_requests) return unknownQuota('Official quota response is invalid');
    }
    const balances: NonNullable<QuotaSnapshot['balances']> = [];
    if (
      nonnegative(d.usage) &&
      (d.limit === null || nonnegative(d.limit)) &&
      (d.limit_remaining === null || nonnegative(d.limit_remaining))
    )
      balances.push({ unit: 'USD', used: d.usage, limit: d.limit, remaining: d.limit_remaining });
    const free = model === 'openrouter/free' || model.endsWith(':free');
    const windows: QuotaSnapshot['windows'] = [];
    if (free) {
      const counter = d.free_model_daily_requests;
      if (
        counter &&
        Number.isSafeInteger(counter.limit) &&
        counter.limit > 0 &&
        Number.isSafeInteger(counter.used) &&
        counter.used >= 0 &&
        Number.isSafeInteger(counter.remaining) &&
        counter.remaining >= 0 &&
        counter.remaining === Math.max(0, counter.limit - counter.used)
      ) {
        const now = new Date();
        windows.push({
          name: 'Free models / UTC day',
          unit: 'requests',
          remaining: counter.remaining,
          limit: counter.limit,
          resetAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
        });
      }
    } else if (nonnegative(d.limit) && d.limit > 0 && nonnegative(d.limit_remaining)) {
      // USD is a spending cap, not tokens or request credits. No local cost deduction is inferred.
      windows.push({
        name: 'API key spending cap',
        unit: 'percent',
        limit: 100,
        remaining: Math.min(100, (d.limit_remaining / d.limit) * 100),
        resetAt: null,
      });
    }
    return {
      source: windows.length ? 'official' : 'unknown',
      observedAt: Date.now(),
      pool: free ? 'openrouter-free-daily' : 'openrouter-key-credit',
      windows,
      balances,
      detail: free
        ? windows.length
          ? 'Official daily free-model requests; per-minute allowance is not reported'
          : 'Official key data retrieved; daily free-model counter is absent or invalid'
        : 'Official API key spending cap; account wallet balance requires a management key',
    };
  } catch {
    checkAbort(signal);
    return unknownQuota('Official quota query failed or timed out');
  }
}
