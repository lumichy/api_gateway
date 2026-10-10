import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayError } from '../errors.ts';
import type { ChatRequest, ErrorKind } from '../types.ts';
import type { ProviderConfig } from './index.ts';
import { checkAbort } from './http.ts';
export function subscriptionEnvironment(type: 'codex' | 'claude'): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (type === 'claude' && (/^ANTHROPIC_/i.test(key) || /^CLAUDE_CODE_/i.test(key)))
      delete env[key];
    if (
      type === 'codex' &&
      /^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_INTERNAL_.*)$/i.test(key)
    )
      delete env[key];
  }
  return env;
}
export function cliErrorKind(text: string): ErrorKind {
  if (/auth|log.?in|logged.?in|not signed|unauthorized|401/i.test(text)) return 'auth_required';
  if (/quota|usage.?limit|credits?.*(?:exhaust|insufficient)|insufficient_quota/i.test(text))
    return 'quota_exhausted';
  if (/rate.?limit|too many requests|429/i.test(text)) return 'rate_limited';
  return 'transient';
}
export async function verifyCliVersion(
  config: ProviderConfig,
  expected: string,
  cwd: string,
  signal: AbortSignal,
) {
  validateBootstrap(config);
  let body = '';
  for await (const line of processLines(
    config.command ?? config.type,
    [...(config.args ?? []), '--version'],
    '',
    cwd,
    signal,
    subscriptionEnvironment(config.type as 'codex' | 'claude'),
  )) {
    body += line;
    if (body.length > 1024) throw new GatewayError('unsupported', 'Unexpected CLI version output');
  }
  if (body.trim() !== expected)
    throw new GatewayError('unsupported', 'CLI version has not been verified for text isolation');
}
export async function cleanupTemporaryDirectory(
  directory: string,
  remove: (path: string) => Promise<void> = (path) => rm(path, { recursive: true, force: true }),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(directory);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= 10 ||
        !['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(code ?? '')
      )
        throw error;
      await delay((attempt + 1) * 50);
    }
  }
}

// Never invoke cmd.exe/PowerShell or shell command strings. On Windows a native
// executable or node.exe with the CLI JS entrypoint as a fixed argument is needed.
export async function* processLines(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): AsyncGenerator<string> {
  checkAbort(signal);
  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  let spawnError: Error | undefined;
  let stderr = '';
  let buffer = '';
  const completion = new Promise<number | null>((resolve) => {
    child.once('error', (e) => {
      spawnError = e;
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const abort = () => {
    child.kill();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of child.stdout) {
      checkAbort(signal);
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        if (Buffer.byteLength(line, 'utf8') > 1048576)
          throw new GatewayError('transient', 'CLI event exceeds maximum size');
        if (line) yield line;
      }
      if (Buffer.byteLength(buffer, 'utf8') > 1048576)
        throw new GatewayError('transient', 'CLI event exceeds maximum size');
    }
    if (Buffer.byteLength(buffer, 'utf8') > 1048576)
      throw new GatewayError('transient', 'CLI event exceeds maximum size');
    if (buffer.trim()) yield buffer;
    const code = await completion;
    checkAbort(signal);
    if (spawnError)
      throw new GatewayError('auth_required', 'Official CLI executable is unavailable');
    if (code !== 0) {
      const kind = /auth|log.?in|not signed/i.test(stderr)
        ? 'auth_required'
        : /quota|credits|usage limit/i.test(stderr)
          ? 'quota_exhausted'
          : /rate.?limit/i.test(stderr)
            ? 'rate_limited'
            : 'transient';
      throw new GatewayError(kind, 'Official CLI exited unsuccessfully');
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (child.exitCode === null) child.kill();
    await completion;
  }
}
export function singleTurn(request: ChatRequest) {
  const messages = request.messages;
  const user = messages.at(-1);
  if (
    user?.role !== 'user' ||
    messages.length > 2 ||
    messages.slice(0, -1).some((m) => m.role !== 'system')
  )
    throw new GatewayError(
      'unsupported',
      'This CLI adapter accepts one user message with an optional leading system message; history and developer roles are unsupported',
    );
  return { user: user.content, system: messages.length === 2 ? messages[0].content : undefined };
}
export function validateBootstrap(config: ProviderConfig) {
  const args = config.args ?? [];
  const officialCodeBuddyEntry =
    config.type === 'codebuddy' && basename(args[0] ?? '') === 'codebuddy';
  if (
    args.length &&
    (args.length !== 1 ||
      !isAbsolute(args[0]) ||
      (!/\.(?:mjs|cjs|js)$/i.test(args[0]) && !officialCodeBuddyEntry) ||
      !/^node(?:\.exe)?$/i.test(basename(config.command ?? '')))
  )
    throw new GatewayError(
      'unsupported',
      'CLI args must be one absolute JavaScript entrypoint for node.exe; runtime flags and prompts are forbidden',
    );
}
