import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig } from './index.ts';
import type { ChatRequest, ProviderEvent, Usage } from '../types.ts';
import { GatewayError } from '../errors.ts';
import { checkAbort, validUsageCount } from './http.ts';
import {
  cleanupTemporaryDirectory,
  cliErrorKind,
  processLines,
  singleTurn,
  subscriptionEnvironment,
  validateBootstrap,
  verifyCliVersion,
} from './subprocess.ts';

// Verified against Codex CLI 0.157.1 with a local Responses capture: no tools,
// user skills, plugins or AGENTS rules were present in the inference request.
export function codexTextFlags(instructions: string): string[] {
  const values: Record<string, string | number | boolean> = {
    model_provider: 'openai',
    forced_login_method: 'chatgpt',
    approval_policy: 'never',
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    model_instructions_file: instructions,
    developer_instructions: '',
    'tools.update_plan.enabled': false,
    'tools.experimental_request_user_input.enabled': false,
    'skills.bundled.enabled': false,
    'skills.include_instructions': false,
  };
  for (const feature of [
    'shell_tool',
    'shell_snapshot',
    'unified_exec',
    'code_mode',
    'code_mode_host',
    'apps',
    'plugins',
    'remote_plugin',
    'hooks',
    'memories',
    'multi_agent',
    'goals',
    'image_generation',
    'browser_use',
    'computer_use',
    'view_image',
    'skill_search',
    'skill_mcp_dependency_install',
    'workspace_dependencies',
    'sleep_tool',
    'tool_suggest',
    'fast_mode',
  ])
    values['features.' + feature] = false;
  return Object.entries(values).flatMap(([key, value]) => [
    '-c',
    key + '=' + JSON.stringify(value),
  ]);
}

async function accountLogin(config: ProviderConfig, cwd: string, signal: AbortSignal) {
  checkAbort(signal);
  const child = spawn(
    config.command ?? 'codex',
    [...(config.args ?? []), '-c', 'forced_login_method="chatgpt"', 'login', 'status'],
    {
      cwd,
      env: subscriptionEnvironment('codex'),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let text = '';
  let oversized = false;
  const collect = (chunk: Buffer) => {
    text += chunk.toString();
    if (text.length > 65536) {
      oversized = true;
      child.kill();
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const abort = () => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    checkAbort(signal);
    if (oversized || code !== 0 || !/Logged in using ChatGPT/.test(text))
      throw new GatewayError('auth_required', 'Codex ChatGPT account login required');
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export async function codexExecHealth(config: ProviderConfig, signal: AbortSignal) {
  validateBootstrap(config);
  const cwd = await mkdtemp(join(tmpdir(), 'gateway-codex-health-'));
  try {
    await verifyCliVersion(config, 'codex-cli 0.157.1', cwd, signal);
    await accountLogin(config, cwd, signal);
    return { available: true, detail: 'Codex CLI 0.157.1; ChatGPT subscription account login' };
  } catch (error) {
    checkAbort(signal);
    return {
      available: false,
      detail: error instanceof GatewayError ? error.message : 'Codex account status unavailable',
    };
  } finally {
    await cleanupTemporaryDirectory(cwd);
  }
}
export async function* codexExecInvoke(
  config: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const { user, system } = singleTurn(request);
  validateBootstrap(config);
  checkAbort(signal);
  const cwd = await mkdtemp(join(tmpdir(), 'gateway-codex-'));
  try {
    await verifyCliVersion(config, 'codex-cli 0.157.1', cwd, signal);
    await accountLogin(config, cwd, signal);
    const instructions = join(cwd, 'instructions.txt');
    await writeFile(
      instructions,
      system ?? 'You are a helpful assistant. Answer the user directly.',
      { mode: 0o600 },
    );
    const args = [
      ...(config.args ?? []),
      'exec',
      '--strict-config',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      '--json',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '--model',
      request.model,
      ...codexTextFlags(instructions),
      '-',
    ];
    let thread = false,
      started = false,
      completed = false,
      bytes = 0,
      count = 0;
    let response: string | undefined;
    let usage: Usage | undefined;
    for await (const line of processLines(
      config.command ?? 'codex',
      args,
      user,
      cwd,
      signal,
      subscriptionEnvironment('codex'),
    )) {
      bytes += Buffer.byteLength(line, 'utf8');
      if (bytes > 8 * 1024 * 1024 || ++count > 10000)
        throw new GatewayError('transient', 'Codex response exceeds maximum size');
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        throw new GatewayError('transient', 'Invalid Codex JSON event');
      }
      if (completed) throw new GatewayError('transient', 'Codex emitted events after completion');
      if (event.type === 'error' || event.type === 'turn.failed')
        throw new GatewayError(cliErrorKind(JSON.stringify(event)), 'Codex request failed');
      if (event.type === 'thread.started') {
        if (thread || started || typeof event.thread_id !== 'string')
          throw new GatewayError('transient', 'Invalid Codex thread initialization');
        thread = true;
      } else if (event.type === 'turn.started') {
        if (!thread || started)
          throw new GatewayError('transient', 'Invalid Codex turn initialization');
        started = true;
      } else if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
        if (
          thread &&
          !started &&
          event.type === 'item.completed' &&
          event.item?.type === 'error' &&
          event.item.message ===
            'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'
        )
          continue;
        if (!started) throw new GatewayError('transient', 'Codex item before initialization');
        const item = event.item;
        if (!item || !['agent_message', 'reasoning'].includes(item.type))
          throw new GatewayError('unsupported', 'Codex emitted an unexpected tool or action');
        if (event.type === 'item.completed' && item.type === 'agent_message') {
          if (response !== undefined || typeof item.text !== 'string' || !item.text)
            throw new GatewayError('transient', 'Codex returned an invalid or multiple response');
          response = item.text;
        }
      } else if (event.type === 'turn.completed') {
        if (!started || response === undefined)
          throw new GatewayError('transient', 'Codex completed without a text response');
        completed = true;
        const u = event.usage;
        if (
          validUsageCount(u?.input_tokens) &&
          validUsageCount(u?.output_tokens) &&
          validUsageCount(u.input_tokens + u.output_tokens)
        )
          usage = {
            prompt_tokens: u.input_tokens,
            completion_tokens: u.output_tokens,
            total_tokens: u.input_tokens + u.output_tokens,
          };
      } else throw new GatewayError('transient', 'Unrecognized Codex event');
    }
    checkAbort(signal);
    if (!completed || response === undefined)
      throw new GatewayError('transient', 'Codex stream ended without completion');
    // exec JSONL has completed messages rather than token deltas. Wait for exit
    // before publishing text so quota/errors can still fall back cleanly.
    yield { type: 'text', text: response };
    yield { type: 'done', finishReason: 'stop', ...(usage ? { usage } : {}) };
  } finally {
    await cleanupTemporaryDirectory(cwd);
  }
}
