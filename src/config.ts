import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { ProviderConfig } from './adapters/index.ts';
export type Config = {
  host: string;
  port: number;
  statePath: string;
  gatewayKeyEnv: string;
  adminKeyEnv: string;
  timeoutMs: number;
  quotaTtlMs: number;
  demoMode: boolean;
  providers: ProviderConfig[];
};
const envName = (v: any) => typeof v === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(v);
const fail = (message: string): never => {
  throw new Error('Configuration: ' + message);
};
function bounded(value: any, min: number, max: number, name: string) {
  if (!Number.isInteger(value) || value < min || value > max) fail(name + ' is out of range');
  return value as number;
}
export function validateConfig(raw: any): Config {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected an object');
  const fields = [
    'host',
    'port',
    'statePath',
    'gatewayKeyEnv',
    'adminKeyEnv',
    'timeoutMs',
    'quotaTtlMs',
    'demoMode',
    'providers',
  ];
  if (Object.keys(raw).some((k) => !fields.includes(k)))
    fail('unknown top-level field or inline secret');
  const host = raw.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) fail('listener must be loopback (127.0.0.1 or ::1)');
  const gatewayKeyEnv = raw.gatewayKeyEnv ?? 'GATEWAY_KEY',
    adminKeyEnv = raw.adminKeyEnv ?? 'GATEWAY_ADMIN_KEY';
  if (!envName(gatewayKeyEnv) || !envName(adminKeyEnv) || gatewayKeyEnv === adminKeyEnv)
    fail('gateway and admin require distinct secret environment references');
  if (raw.demoMode !== undefined && typeof raw.demoMode !== 'boolean')
    fail('demoMode must be boolean');
  if (raw.statePath !== undefined && (typeof raw.statePath !== 'string' || !raw.statePath))
    fail('statePath must be a nonempty path');
  if (!Array.isArray(raw.providers) || raw.providers.length < 1 || raw.providers.length > 32)
    fail('providers must contain 1 to 32 entries');
  const seen = new Set<string>();
  const providerFields = [
    'id',
    'type',
    'models',
    'enabled',
    'priority',
    'maxConcurrency',
    'billingVerified',
    'apiKeyEnv',
    'baseUrl',
    'command',
    'args',
    'mode',
    'tokenEnv',
    'approvedHooksSha256',
    'demo',
  ];
  const providers: ProviderConfig[] = raw.providers.map((p: any): ProviderConfig => {
    if (
      !p ||
      typeof p !== 'object' ||
      Array.isArray(p) ||
      Object.keys(p).some((k) => !providerFields.includes(k))
    )
      fail('invalid provider fields');
    if (typeof p.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(p.id) || seen.has(p.id))
      fail('provider ids must be unique lowercase identifiers');
    seen.add(p.id);
    if (!['ark', 'codex', 'claude', 'codebuddy', 'antigravity', 'demo'].includes(p.type))
      fail('unknown provider type');
    if (
      p.approvedHooksSha256 !== undefined &&
      (p.type !== 'antigravity' ||
        typeof p.approvedHooksSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(p.approvedHooksSha256))
    )
      fail('approvedHooksSha256 requires an Antigravity hook configuration SHA-256');
    if (
      !Array.isArray(p.models) ||
      !p.models.length ||
      p.models.length > 64 ||
      new Set(p.models).size !== p.models.length ||
      p.models.some((m: any) => typeof m !== 'string' || !m || m.length > 128 || m.includes('/'))
    )
      fail('models must be unique nonempty alias-safe names');
    for (const name of ['enabled', 'billingVerified'])
      if (p[name] !== undefined && typeof p[name] !== 'boolean') fail(name + ' must be boolean');
    for (const name of ['apiKeyEnv', 'tokenEnv'])
      if (p[name] !== undefined && !envName(p[name]))
        fail(name + ' must reference an environment variable');
    if (
      p.args !== undefined &&
      (!Array.isArray(p.args) || p.args.some((a: any) => typeof a !== 'string' || a.includes('\0')))
    )
      fail('args must be a fixed string array');
    if (
      p.command !== undefined &&
      (typeof p.command !== 'string' || !p.command || p.command.includes('\0'))
    )
      fail('invalid command');
    if (p.mode !== undefined && !['app-server', 'responses', 'exec'].includes(p.mode))
      fail('unsupported adapter mode');
    if (p.baseUrl !== undefined) {
      try {
        const u = new URL(p.baseUrl);
        if (
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          !['https:', 'http:'].includes(u.protocol)
        )
          fail('invalid baseUrl');
      } catch {
        fail('invalid baseUrl');
      }
    }
    if (p.demo !== undefined) {
      if (
        !p.demo ||
        p.type !== 'demo' ||
        Object.keys(p.demo).some((k) => !['remaining', 'fail', 'text'].includes(k))
      )
        fail('invalid demo fields');
      if (
        p.demo.remaining !== undefined &&
        p.demo.remaining !== null &&
        (typeof p.demo.remaining !== 'number' ||
          !Number.isFinite(p.demo.remaining) ||
          p.demo.remaining < 0)
      )
        fail('demo remaining must be nonnegative');
      if (p.demo.text !== undefined && typeof p.demo.text !== 'string')
        fail('demo text must be string');
      if (
        p.demo.fail !== undefined &&
        ![
          'quota_exhausted',
          'rate_limited',
          'auth_required',
          'transient',
          'invalid_request',
          'unsupported',
        ].includes(p.demo.fail)
      )
        fail('invalid demo failure');
    }
    return {
      ...p,
      enabled: p.enabled ?? p.type === 'demo',
      billingVerified: p.billingVerified ?? false,
      priority: bounded(p.priority ?? 100, 0, 10000, 'priority'),
      maxConcurrency: bounded(p.maxConcurrency ?? 1, 1, 32, 'maxConcurrency'),
    };
  });
  if (raw.demoMode && providers.some((p) => p.type !== 'demo'))
    fail('demoMode cannot include real subscription providers');
  return {
    host,
    port: bounded(raw.port ?? 8787, 1, 65535, 'port'),
    statePath: raw.statePath ?? 'data/gateway.sqlite',
    gatewayKeyEnv,
    adminKeyEnv,
    timeoutMs: bounded(raw.timeoutMs ?? 120000, 100, 600000, 'timeoutMs'),
    quotaTtlMs: bounded(raw.quotaTtlMs ?? 60000, 100, 3600000, 'quotaTtlMs'),
    demoMode: raw.demoMode ?? false,
    providers,
  };
}
export async function loadConfig(path: string): Promise<Config> {
  const full = resolve(path);
  let raw: any;
  try {
    const text = await readFile(full, 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 65279 ? text.slice(1) : text);
  } catch {
    throw new Error('Cannot read configuration JSON: ' + full);
  }
  const config = validateConfig(raw);
  return {
    ...config,
    statePath:
      config.statePath === ':memory:' ? ':memory:' : resolve(dirname(full), config.statePath),
  };
}
export function secrets(config: Config): { gatewayKey: string; adminKey: string } {
  const gatewayKey = config.demoMode
    ? 'demo-local-gateway-key-12345678'
    : process.env[config.gatewayKeyEnv];
  const adminKey = config.demoMode
    ? 'demo-local-admin-key-1234567890'
    : process.env[config.adminKeyEnv];
  if (
    !gatewayKey ||
    !adminKey ||
    gatewayKey.length < 24 ||
    adminKey.length < 24 ||
    gatewayKey === adminKey
  )
    throw new Error(
      'Set distinct ' +
        config.gatewayKeyEnv +
        ' and ' +
        config.adminKeyEnv +
        ' environment values of at least 24 characters',
    );
  return { gatewayKey, adminKey };
}
