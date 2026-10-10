import type { ProviderConfig } from './index.ts';
import type { QuotaSnapshot } from '../types.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAbort } from './http.ts';
import { cleanupTemporaryDirectory, processLines } from './subprocess.ts';

const unavailable = (now: number): QuotaSnapshot => ({
  source: 'unknown',
  observedAt: now,
  windows: [],
  detail:
    'Official Ark quota requires the Ark CLI and separate control-plane authentication (SSO/STS or AK/SK)',
});

// Official CLI quota contract; inference API keys do not replace control-plane credentials.
// https://github.com/volcengine/ark-cli/blob/main/skills/arkcli-usage/references/arkcli-usage-plan.md
export function parseArkQuota(value: unknown, now = Date.now()): QuotaSnapshot {
  const v = value as any;
  if (!Array.isArray(v?.items)) return unavailable(now);
  const matching = v.items.filter((item: any) => item?.product === 'coding-plan');
  if (matching.length !== 1) return unavailable(now);
  const item = matching[0];
  if (
    item.subscribed !== true ||
    item.error ||
    !Array.isArray(item.periods) ||
    !item.periods.length
  )
    return unavailable(now);
  let observedAt = now;
  if (item.updated_at !== undefined) {
    if (!Number.isSafeInteger(item.updated_at) || item.updated_at <= 0 || item.updated_at > now)
      return unavailable(now);
    observedAt = item.updated_at;
  }
  const labels = ['session', 'weekly', 'monthly'];
  const seen = new Set<string>();
  const windows: QuotaSnapshot['windows'] = [];
  for (const period of item.periods) {
    if (
      !labels.includes(period?.label) ||
      seen.has(period.label) ||
      typeof period.percent !== 'number' ||
      !Number.isFinite(period.percent) ||
      period.percent < 0 ||
      period.percent > 100
    )
      return unavailable(now);
    seen.add(period.label);
    let resetAt: number | null = null;
    if (period.reset_at !== undefined) {
      if (
        typeof period.reset_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          period.reset_at,
        )
      )
        return unavailable(now);
      resetAt = Date.parse(period.reset_at);
      if (!Number.isFinite(resetAt) || resetAt <= now) return unavailable(now);
    }
    windows.push({
      name: period.label,
      unit: 'percent',
      remaining: 100 - period.percent,
      limit: 100,
      usedPercent: period.percent,
      resetAt,
    });
  }
  windows.sort((a, b) => labels.indexOf(a.name!) - labels.indexOf(b.name!));
  return { source: 'official', observedAt, pool: 'ark-coding-plan', windows };
}
export async function arkQuota(
  config: ProviderConfig,
  signal: AbortSignal,
): Promise<QuotaSnapshot> {
  checkAbort(signal);
  let directory: string | undefined;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  try {
    // Batch scripts would require a shell, so only invoke a native executable.
    const command = config.quotaCommand ?? 'arkcli';
    if (/\.(?:cmd|bat|ps1)$/i.test(command)) return unavailable(Date.now());
    directory = await mkdtemp(join(tmpdir(), 'gateway-ark-quota-'));
    const environment = {
      ...process.env,
      ARKCLI_NO_UPDATE_NOTIFIER: '1',
      ARKCLI_CALLER_TYPE: 'ai_agent',
      ARKCLI_CALLER_NAME: 'codex',
      ARKCLI_SKILL_NAME: 'arkcli-usage',
    };
    for (const key of Object.keys(environment)) {
      if (/API_?KEY$/i.test(key)) delete (environment as NodeJS.ProcessEnv)[key];
    }
    let body = '';
    for await (const line of processLines(
      command,
      ['usage', 'plan', '--product', 'coding-plan', '--format', 'json'],
      '',
      directory,
      bounded,
      environment,
    )) {
      body += line;
      if (Buffer.byteLength(body, 'utf8') > 65536) return unavailable(Date.now());
    }
    checkAbort(signal);
    return parseArkQuota(JSON.parse(body));
  } catch {
    checkAbort(signal);
    return unavailable(Date.now());
  } finally {
    if (directory) await cleanupTemporaryDirectory(directory);
  }
}
