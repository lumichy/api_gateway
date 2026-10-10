import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayError } from '../errors.ts';
import type { ChatRequest, ProviderEvent, Usage } from '../types.ts';
import type { ProviderConfig } from './index.ts';
import { checkAbort, validUsageCount } from './http.ts';
import {
  processLines,
  singleTurn,
  validateBootstrap,
  cleanupTemporaryDirectory,
  cliErrorKind,
} from './subprocess.ts';

type PrintCliOptions = {
  command: string;
  args: (system: string | undefined) => string[];
  environment?: () => NodeJS.ProcessEnv;
  prepare?: (directory: string) => Promise<void>;
  validateInit?: (event: { apiKeySource?: unknown }) => void;
};
export function printCliArgs(model: string): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--no-session-persistence',
    '--model',
    model,
  ];
}

// Shared stream-json contract; account-specific rules belong in each adapter.
export async function* printCliInvoke(
  config: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
  options: PrintCliOptions,
): AsyncGenerator<ProviderEvent> {
  const { user, system } = singleTurn(request);
  checkAbort(signal);
  // Operator fixed args are limited to executable bootstrap paths, never flags:
  // overriding safety flags, session continuation, settings or hooks is rejected.
  validateBootstrap(config);
  const directory = await mkdtemp(join(tmpdir(), 'gateway-agent-'));
  let terminal: any;
  let text = '';
  let initialized = false;
  let bytes = 0;
  let count = 0;
  const args = options.args(system);
  try {
    await options.prepare?.(directory);
    for await (const line of processLines(
      options.command,
      args,
      user,
      directory,
      signal,
      options.environment?.(),
    )) {
      let event: any;
      bytes += Buffer.byteLength(line, 'utf8');
      if (bytes > 8 * 1024 * 1024 || ++count > 10000)
        throw new GatewayError('transient', 'CLI response exceeds maximum size');
      try {
        event = JSON.parse(line);
      } catch {
        throw new GatewayError('transient', 'Invalid CLI stream JSON');
      }
      if (terminal) throw new GatewayError('transient', 'CLI emitted events after its result');
      if (event.type === 'system' && (event.subtype === 'init' || event.subtype === undefined)) {
        if (!Array.isArray(event.tools) || event.tools.length)
          throw new GatewayError('unsupported', 'CLI reported active tools despite no-tools flags');
        options.validateInit?.(event);
        initialized = true;
      } else if (!initialized)
        throw new GatewayError('transient', 'CLI response arrived before initialization');
      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_start' &&
        event.event.content_block?.type === 'tool_use'
      )
        throw new GatewayError('unsupported', 'Unexpected CLI tool call');
      if (
        event.type === 'stream_event' &&
        event.event?.type === 'content_block_delta' &&
        event.event.delta?.type === 'text_delta'
      ) {
        if (typeof event.event.delta.text !== 'string')
          throw new GatewayError('transient', 'Invalid CLI text delta');
        text += event.event.delta.text;
        yield { type: 'text', text: event.event.delta.text };
      }
      if (
        event.type === 'assistant' &&
        event.message?.content?.some((b: any) => b.type === 'tool_use')
      )
        throw new GatewayError('unsupported', 'Unexpected CLI tool call');
      if (event.type === 'result') terminal = event;
    }
    checkAbort(signal);
    if (!terminal) throw new GatewayError('transient', 'CLI stream ended without result');
    if (terminal.is_error || terminal.subtype !== 'success')
      throw new GatewayError(cliErrorKind(JSON.stringify(terminal)), 'CLI request failed');
    if (
      typeof terminal.result !== 'string' ||
      !terminal.result ||
      !terminal.result.startsWith(text)
    )
      throw new GatewayError('transient', 'CLI result does not match streamed text');
    if (terminal.result.length > text.length)
      yield { type: 'text', text: terminal.result.slice(text.length) };
    const u = terminal.usage;
    let usage: Usage | undefined;
    const cacheRead = u?.cache_read_input_tokens === undefined ? 0 : u.cache_read_input_tokens;
    const cacheCreate =
      u?.cache_creation_input_tokens === undefined ? 0 : u.cache_creation_input_tokens;
    if (
      u &&
      validUsageCount(u.input_tokens) &&
      validUsageCount(u.output_tokens) &&
      validUsageCount(cacheRead) &&
      validUsageCount(cacheCreate)
    ) {
      const input = u.input_tokens + cacheRead + cacheCreate;
      const total = input + u.output_tokens;
      if (validUsageCount(input) && validUsageCount(total))
        usage = { prompt_tokens: input, completion_tokens: u.output_tokens, total_tokens: total };
    }
    yield { type: 'done', finishReason: 'stop', ...(usage ? { usage } : {}) };
  } finally {
    await cleanupTemporaryDirectory(directory);
  }
}
