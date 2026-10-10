import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { codeBuddyTextFlags } from '../src/adapters/codebuddy.ts';

export const codeBuddyVersion = '2.161.0';
export interface CodeBuddyInstallation { entry: string; version: string }

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

export async function resolveCodeBuddyInstallation(root: string): Promise<CodeBuddyInstallation> {
  const projectRoot = await realpath(resolve(root));
  const packageRoot = await realpath(join(projectRoot, '.tools/codebuddy/node_modules/@tencent-ai/codebuddy-code'));
  if (!inside(projectRoot, packageRoot)) throw new Error('CodeBuddy package must remain inside the project');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (manifest.name !== '@tencent-ai/codebuddy-code' || manifest.version !== codeBuddyVersion) {
    throw new Error(`Expected official @tencent-ai/codebuddy-code version ${codeBuddyVersion}`);
  }
  const bin = manifest.bin;
  const entryPath = typeof bin === 'object' && bin !== null ? (bin as Record<string, unknown>).codebuddy : undefined;
  if (typeof entryPath !== 'string' || !entryPath || entryPath.includes('\0') || isAbsolute(entryPath) || win32.isAbsolute(entryPath)) {
    throw new Error('Invalid official CodeBuddy bin.codebuddy entry');
  }
  const candidate = resolve(packageRoot, entryPath);
  if (!inside(packageRoot, candidate)) throw new Error('CodeBuddy entry escapes its package directory');
  const entry = await realpath(candidate);
  if (!inside(packageRoot, entry) || !(await stat(entry)).isFile()) throw new Error('CodeBuddy entry must be a file inside its package');
  const source = await readFile(entry, 'utf8');
  if (!/^#![^\r\n]*\bnode(?:\s|\r?\n|$)/.test(source)) throw new Error('CodeBuddy entry must be a Node script');
  return { entry, version: codeBuddyVersion };
}

export function codeBuddyLoginArgs(entry: string): string[] {
  return [entry, '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true }), '--no-session-persistence',...codeBuddyTextFlags()];
}

export async function prepareCodeBuddy(root: string, nodeExecutable: string) {
  if (!isAbsolute(nodeExecutable)) throw new Error('Node executable must be an absolute path');
  const installation = await resolveCodeBuddyInstallation(root);
  const configPath = join(resolve(root), 'config.local.json');
  const config = {
    host: '127.0.0.1', port: 8787, statePath: 'data/gateway.sqlite',
    gatewayKeyEnv: 'GATEWAY_KEY', adminKeyEnv: 'GATEWAY_ADMIN_KEY', timeoutMs: 120000, quotaTtlMs: 60000,
    providers: [{ id: 'codebuddy', type: 'codebuddy', models: ['hy3'], enabled: false,
      billingVerified: false, command: nodeExecutable, args: [installation.entry], priority: 10, maxConcurrency: 1 }],
  };
  let created = false;
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return { ...installation, configPath, created };
}
