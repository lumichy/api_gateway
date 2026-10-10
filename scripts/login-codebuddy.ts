import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeBuddyLoginArgs, prepareCodeBuddy, resolveCodeBuddyInstallation } from './codebuddy.ts';

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.some(arg => arg !== '--check-only' && arg !== '--prepare-only') || args.length > 1) {
    throw new Error('Usage: node scripts/login-codebuddy.ts [--check-only | --prepare-only]');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (args.includes('--check-only')) {
    const installation = await resolveCodeBuddyInstallation(root);
    console.log(JSON.stringify({ node: process.execPath, ...installation, loginVerified: false }, null, 2));
    return 0;
  }
  const prepared = await prepareCodeBuddy(root, process.execPath);
  console.log(`${prepared.created ? 'Created' : 'Preserved'} ${prepared.configPath}`);
  console.log('Provider remains disabled until login and subscription billing are verified.');
  if (args.includes('--prepare-only')) return 0;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this login helper yourself in an interactive terminal.');
  const isolatedDirectory = await mkdtemp(join(tmpdir(), 'gateway-codebuddy-login-'));
  try {
    return await new Promise<number>((accept, reject) => {
      const child = spawn(process.execPath, codeBuddyLoginArgs(prepared.entry), {
        cwd: isolatedDirectory, stdio: 'inherit', shell: false, windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => accept(code ?? (signal ? 1 : 0)));
    });
  } finally { await rm(isolatedDirectory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : 'CodeBuddy setup failed');
    process.exitCode = 1;
  });
}
