import { loadConfig } from '../src/config.ts';

const value = (name: string) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const result = process.argv[i + 1];
  if (!result || result.startsWith('--')) throw new Error(name + ' requires a value');
  return result;
};

try {
  const config = await loadConfig(value('--config') ?? 'config.local.json');
  const key = process.env[config.adminKeyEnv];
  if (!key) throw new Error('Admin key environment variable is missing');
  const provider = value('--provider');
  const model = value('--model');
  const host = config.host === '::1' ? '[::1]' : config.host;
  const response = await fetch(`http://${host}:${config.port}/admin/quota/refresh`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Quota refresh returned HTTP ' + response.status);
  console.log(JSON.stringify(await response.json(), null, 2));
} catch {
  console.error(
    'Quota refresh failed. Check the running gateway, config and admin key environment.',
  );
  process.exitCode = 1;
}
