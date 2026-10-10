import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayError } from '../errors.ts';
import type { ChatRequest, ProviderEvent } from '../types.ts';
import type { ProviderConfig } from './index.ts';
import { checkAbort } from './http.ts';
import { processLines, validateBootstrap, cleanupTemporaryDirectory } from './subprocess.ts';
import { printCliInvoke, printCliArgs } from './cli-stream.ts';
import { subscriptionEnvironment, verifyCliVersion } from './subprocess.ts';
import { verifyClaudePolicy } from './claude-policy.ts';

export async function claudeHealth(config: ProviderConfig, signal: AbortSignal) {
  validateBootstrap(config);
  checkAbort(signal);
  const directory = await mkdtemp(join(tmpdir(), 'gateway-health-'));
  let healthBytes = 0;
  const addHealth = (line: string) => {
    healthBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (healthBytes > 65536)
      throw new GatewayError('transient', 'CLI health output limit exceeded');
  };
  try {
    let body = '';
    await verifyClaudePolicy(signal);
    for await (const line of processLines(
      config.command ?? 'claude',
      [
        ...(config.args ?? []),
        '--safe-mode',
        '--setting-sources',
        '',
        '--settings',
        '{"disableAllHooks":true}',
        'auth',
        'status',
      ],
      '',
      directory,
      signal,
      subscriptionEnvironment('claude'),
    )) {
      addHealth(line);
      body += line;
    }
    const status = JSON.parse(body);
    return {
      available:
        status.loggedIn === true &&
        status.authMethod === 'claude.ai' &&
        status.apiProvider === 'firstParty' &&
        ['pro', 'max'].includes(status.subscriptionType),
      detail:
        status.loggedIn &&
        status.authMethod === 'claude.ai' &&
        status.apiProvider === 'firstParty' &&
        ['pro', 'max'].includes(status.subscriptionType)
          ? 'Claude subscription login present; extra usage must be disabled by operator'
          : 'CLI subscription login required',
    };
  } catch (e) {
    checkAbort(signal);
    return {
      available: false,
      detail:
        e instanceof GatewayError && e.message === 'CLI health output limit exceeded'
          ? e.message
          : 'Official CLI authentication status unavailable',
    };
  } finally {
    await cleanupTemporaryDirectory(directory);
  }
}

export async function* claudeInvoke(
  config: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
  observeEvent?: (event: unknown) => void,
): AsyncGenerator<ProviderEvent> {
  yield* printCliInvoke(config, request, signal, {
    command: config.command ?? 'claude',
    observeEvent,
    args: (system) => [
      ...(config.args ?? []),
      ...printCliArgs(request.model),
      '--safe-mode',
      '--setting-sources',
      '',
      '--settings',
      '{"disableAllHooks":true}',
      '--disable-slash-commands',
      '--no-chrome',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      ...(system === undefined ? [] : ['--system-prompt', system]),
    ],
    environment: () => subscriptionEnvironment('claude'),
    prepare: async (directory) => {
      const health = await claudeHealth(config, signal);
      if (!health.available)
        throw new GatewayError('auth_required', 'Claude Pro/Max account login required');
      await verifyCliVersion(config, '2.1.296 (Claude Code)', directory, signal);
    },
    validateInit: (event) => {
      if (event.apiKeySource !== 'none')
        throw new GatewayError(
          'auth_required',
          'CLI did not use subscription account authentication',
        );
    },
  });
}
