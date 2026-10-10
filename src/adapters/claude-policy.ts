import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GatewayError } from '../errors.ts';
import { checkAbort } from './http.ts';

const run = promisify(execFile);
function policyPaths(): string[] {
  const system =
    process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'ClaudeCode')
      : process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode'
        : '/etc/claude-code';
  return [
    join(system, 'managed-settings.json'),
    join(system, 'managed-settings.d'),
    join(system, 'managed-mcp.json'),
    join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'remote-settings.json'),
    ...(process.platform === 'darwin'
      ? ['/Library/Managed Preferences/com.anthropic.claudecode.plist']
      : []),
  ];
}
async function registryPolicy(signal: AbortSignal): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  // Fixed read-only command. Never print registry contents or execute a policy.
  const script =
    "$ErrorActionPreference='Stop'; $found=$false; foreach($path in @('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode','Registry::HKEY_CURRENT_USER\\SOFTWARE\\Policies\\ClaudeCode')) { if(Test-Path -LiteralPath $path) { $found=$true } }; if($found) { 'present' } else { 'absent' }";
  try {
    const { stdout } = await run(
      join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, signal, timeout: 3000, maxBuffer: 4096 },
    );
    if (!['present', 'absent'].includes(stdout.trim())) throw new Error('Unknown registry status');
    return stdout.trim() === 'present';
  } catch {
    checkAbort(signal);
    throw new GatewayError('unsupported', 'Claude managed policy status could not be verified');
  }
}
export async function verifyClaudePolicy(
  signal: AbortSignal,
  paths = policyPaths(),
  registry: () => Promise<boolean> = () => registryPolicy(signal),
) {
  checkAbort(signal);
  for (const path of paths) {
    let present = false;
    try {
      await stat(path);
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new GatewayError('unsupported', 'Claude managed policy status could not be verified');
    }
    if (present)
      throw new GatewayError(
        'unsupported',
        'Claude managed policies require separate text-isolation verification',
      );
  }
  if (await registry())
    throw new GatewayError(
      'unsupported',
      'Claude managed policies require separate text-isolation verification',
    );
  checkAbort(signal);
}
