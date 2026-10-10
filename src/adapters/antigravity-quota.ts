import type { ProviderConfig } from './index.ts';
import type { QuotaSnapshot } from '../types.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAbort } from './http.ts';
import { verifyAntigravityProfile } from './antigravity.ts';
import { cleanupTemporaryDirectory, processLines, validateBootstrap } from './subprocess.ts';

const unknown = (now: number, detail: string): QuotaSnapshot => ({
  source: 'unknown',
  observedAt: now,
  windows: [],
  detail,
});
const family = (model: string) =>
  /^gemini-/i.test(model)
    ? 'gemini'
    : /^(?:claude-|gpt-oss(?:-|$))/i.test(model)
      ? '3p'
      : undefined;

// CLI 1.3.3's native read-only /usage handler. No model request is needed.
// https://www.antigravity.google/docs/changelog#v1111
export function parseAntigravityQuota(
  value: unknown,
  model: string,
  now = Date.now(),
): QuotaSnapshot {
  const unavailable = () =>
    unknown(now, 'Official Antigravity quota response is unavailable or unsupported');
  const pool = family(model);
  const v = value as any;
  if (
    !pool ||
    !v ||
    v.status !== 'SUCCESS' ||
    v.conversation_id !== '' ||
    v.num_turns !== 0 ||
    v.duration_seconds !== 0 ||
    v.command?.name !== 'usage' ||
    ![
      'input_tokens',
      'output_tokens',
      'thinking_tokens',
      'cache_read_tokens',
      'total_tokens',
    ].every((key) => v.usage?.[key] === 0) ||
    !Array.isArray(v.command?.data?.groups)
  )
    return unavailable();
  const wanted = [`${pool}-weekly`, `${pool}-5h`];
  const matching = v.command.data.groups.filter(
    (group: any) =>
      Array.isArray(group?.buckets) &&
      group.buckets.some((bucket: any) => wanted.includes(bucket?.id)),
  );
  if (matching.length !== 1) return unavailable();
  const buckets = matching[0].buckets;
  const windows: QuotaSnapshot['windows'] = [];
  for (const id of wanted) {
    const matches = buckets.filter((bucket: any) => bucket?.id === id);
    if (matches.length !== 1) return unavailable();
    const bucket = matches[0];
    const fraction = bucket.remaining_fraction;
    const resetAt =
      typeof bucket.reset_time === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(bucket.reset_time)
        ? Date.parse(bucket.reset_time)
        : NaN;
    if (
      typeof fraction !== 'number' ||
      !Number.isFinite(fraction) ||
      fraction < 0 ||
      fraction > 1 ||
      !Number.isFinite(resetAt) ||
      resetAt <= now ||
      bucket.window !== (id.endsWith('-weekly') ? 'weekly' : '5h')
    )
      return unavailable();
    windows.push({
      unit: 'percent',
      name: id,
      remaining: fraction * 100,
      limit: 100,
      usedPercent: (1 - fraction) * 100,
      resetAt,
    });
  }
  return { source: 'official', observedAt: now, pool, windows };
}
export async function antigravityQuota(
  config: ProviderConfig,
  model: string,
  signal: AbortSignal,
  root?: string,
): Promise<QuotaSnapshot> {
  checkAbort(signal);
  if (!family(model))
    return unknown(Date.now(), 'Antigravity quota group is unknown for this model');
  let directory: string | undefined;
  const timeout = AbortSignal.timeout(15000);
  const bounded = AbortSignal.any([signal, timeout]);
  try {
    validateBootstrap(config);
    await verifyAntigravityProfile(root, config.approvedHooksSha256);
    directory = await mkdtemp(join(tmpdir(), 'gateway-agy-quota-'));
    const environment: NodeJS.ProcessEnv = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
    for (const name of [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ])
      delete environment[name];
    let version = '';
    for await (const line of processLines(
      config.command ?? 'agy',
      [...(config.args ?? []), '--version'],
      '',
      directory,
      bounded,
      environment,
    )) {
      version += line;
      if (version.length > 1024)
        return unknown(Date.now(), 'Antigravity quota CLI version is unsupported');
    }
    if (version.trim() !== '1.3.3')
      return unknown(Date.now(), 'Antigravity quota requires verified CLI 1.3.3');
    let body = '';
    for await (const line of processLines(
      config.command ?? 'agy',
      [
        ...(config.args ?? []),
        '-p',
        '/usage',
        '--output-format',
        'json',
        '--print-timeout',
        '10s',
        '--log-file',
        join(directory, 'cli.log'),
      ],
      '',
      directory,
      bounded,
      environment,
    )) {
      body += line;
      if (Buffer.byteLength(body, 'utf8') > 65536)
        return unknown(Date.now(), 'Antigravity quota output exceeded its limit');
    }
    checkAbort(signal);
    return parseAntigravityQuota(JSON.parse(body), model);
  } catch {
    checkAbort(signal);
    return unknown(
      Date.now(),
      'Official Antigravity quota query failed; authentication, network or CLI support unavailable',
    );
  } finally {
    if (directory) await cleanupTemporaryDirectory(directory);
  }
}
