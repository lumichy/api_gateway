import { readFile, readdir, mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { GatewayError } from '../errors.ts';
import type { ChatRequest, ProviderEvent, Usage, ErrorKind } from '../types.ts';
import type { ProviderConfig } from './index.ts';
import { checkAbort, validUsageCount } from './http.ts';
import {
  processLines,
  singleTurn,
  validateBootstrap,
  cleanupTemporaryDirectory,
} from './subprocess.ts';

// Each version is admitted only after live Agent isolation and protocol checks.
const supportedVersions = ['1.3.1', '1.3.2'];
const profileDirectory = () => join(homedir(), '.gemini');

async function optionalJSON(file: string): Promise<any> {
  try {
    const raw = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim();
    if (!raw) return {};
    if (Buffer.byteLength(raw) > 1048576) throw new Error('too large');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new GatewayError('unsupported', 'Antigravity profile configuration cannot be verified');
  }
}

// The native CLI reads its cached account itself. Never extract or copy tokens.
// Global extensions cannot be disabled through a CLI flag; refuse them rather
// than mutating the operator's profile or allowing startup hooks/MCP processes.
export async function antigravityHooksDigest(root = profileDirectory()) {
  const hooks: { file: string; definition: unknown }[] = [];
  for (const folder of ['antigravity-cli', 'config']) {
    for (const file of ['settings.json', 'hooks.json']) {
      const data = await optionalJSON(join(root, folder, file));
      const definitions = file === 'settings.json' ? (data.hooks ?? {}) : data;
      const active = Object.fromEntries(
        Object.entries(definitions).filter(
          ([, definition]) => (definition as any)?.enabled !== false,
        ),
      );
      if (Object.keys(active).length) hooks.push({ file: folder + '/' + file, definition: active });
    }
  }
  return hooks.length
    ? createHash('sha256').update(JSON.stringify(hooks)).digest('hex')
    : undefined;
}

export async function verifyAntigravityProfile(
  root = profileDirectory(),
  approvedHooksSha256?: string,
) {
  for (const file of ['AGENTS.md', 'GEMINI.md', 'config/AGENTS.md', 'config/GEMINI.md']) {
    try {
      if ((await stat(join(root, file))).size > 0)
        throw new GatewayError(
          'unsupported',
          'Antigravity automatic global instructions are unsupported by the text gateway',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const hooksDigest = await antigravityHooksDigest(root);
  if (hooksDigest && hooksDigest !== approvedHooksSha256)
    throw new GatewayError(
      'unsupported',
      'Antigravity global hooks require explicit approval of their current configuration',
    );
  for (const folder of ['antigravity-cli', 'config']) {
    const settings = await optionalJSON(join(root, folder, 'settings.json'));
    if (
      settings.modelProvider !== undefined ||
      (settings.useG1Credits !== undefined && settings.useG1Credits !== false)
    )
      throw new GatewayError(
        'unsupported',
        'Antigravity requires account-default billing with extra AI credits disabled',
      );
    for (const file of ['mcp_config.json']) {
      const data = await optionalJSON(join(root, folder, file));
      if (Object.keys(data.mcpServers ?? {}).length)
        throw new GatewayError(
          'unsupported',
          'Antigravity global MCP or hooks are unsupported by the text gateway',
        );
    }
    for (const directory of ['rules', 'plugins', 'hooks']) {
      try {
        if ((await readdir(join(root, folder, directory))).length)
          throw new GatewayError(
            'unsupported',
            'Antigravity global rules, plugins or hooks are unsupported by the text gateway',
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

async function verifyVersion(config: ProviderConfig, signal: AbortSignal) {
  validateBootstrap(config);
  let version = '';
  for await (const line of processLines(
    config.command ?? 'agy',
    [...(config.args ?? []), '--version'],
    '',
    tmpdir(),
    signal,
  )) {
    version += line;
    if (version.length > 1024)
      throw new GatewayError('unsupported', 'Unexpected Antigravity version output');
  }
  if (!supportedVersions.includes(version.trim()))
    throw new GatewayError(
      'unsupported',
      'Antigravity CLI supported versions: ' +
        supportedVersions.join(', ') +
        '; validate other versions before enabling',
    );
  return version.trim();
}

export async function antigravityHealth(
  config: ProviderConfig,
  signal: AbortSignal,
  root = profileDirectory(),
) {
  try {
    checkAbort(signal);
    await verifyAntigravityProfile(root, config.approvedHooksSha256);
    const version = await verifyVersion(config, signal);
    return {
      available: true,
      detail:
        'Antigravity CLI ' + version + ' present; cached account login required; quota unknown',
    };
  } catch (error) {
    checkAbort(signal);
    return {
      available: false,
      detail: error instanceof GatewayError ? error.message : 'Antigravity profile unavailable',
    };
  }
}

function failureKind(error: unknown): ErrorKind {
  const text = typeof error === 'string' ? error : JSON.stringify(error ?? '');
  if (/auth|log.?in|not signed|unauthorized/i.test(text)) return 'auth_required';
  if (/quota|usage.?limit|credits?.*(?:exhaust|insufficient)|resource_exhausted/i.test(text))
    return 'quota_exhausted';
  if (/rate.?limit|too many requests|429/i.test(text)) return 'rate_limited';
  return 'transient';
}

export async function* antigravityInvoke(
  config: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
  root = profileDirectory(),
): AsyncGenerator<ProviderEvent> {
  const { user, system } = singleTurn(request);
  checkAbort(signal);
  await verifyAntigravityProfile(root, config.approvedHooksSha256);
  await verifyVersion(config, signal);
  checkAbort(signal);
  const directory = await mkdtemp(join(tmpdir(), 'gateway-agy-'));
  const agent = 'gateway-text-' + randomUUID();
  let initialized = false;
  let terminal: any;
  let text = '';
  let bytes = 0;
  let events = 0;
  try {
    const agentFolder = join(directory, '.agents', 'agents', agent);
    await mkdir(agentFolder, { recursive: true });
    await writeFile(
      join(agentFolder, 'agent.md'),
      `---\nname: ${agent}\ndescription: Text-only subscription gateway\nmainAgent: true\nsubagent: false\ntools: []\nmcpServers: []\nskills: []\nplugins: []\ncommandExecutionPolicy: off\n---\n${system ?? 'You are a helpful assistant. Answer directly without tools.'}`,
      { mode: 0o600 },
    );
    const args = [
      ...(config.args ?? []),
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--agent',
      agent,
      '--model',
      request.model,
      '--disable-slash-commands',
      '--print-timeout',
      '120s',
      '--log-file',
      join(directory, 'cli.log'),
    ];
    const environment = { ...process.env };
    for (const name of [
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ])
      delete environment[name];
    for await (const line of processLines(
      config.command ?? 'agy',
      args,
      JSON.stringify({ event: 'user', message: { content: user } }) + '\n',
      directory,
      signal,
      environment,
    )) {
      bytes += Buffer.byteLength(line);
      if (bytes > 8388608 || ++events > 10000)
        throw new GatewayError('transient', 'Antigravity stream limit exceeded');
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        throw new GatewayError('transient', 'Invalid Antigravity stream JSON');
      }
      if (terminal)
        throw new GatewayError('transient', 'Antigravity emitted data after its terminal result');
      if (event?.event === 'init') {
        const init = event.init;
        if (
          initialized ||
          !init ||
          init.agent !== agent ||
          init.model !== request.model ||
          typeof init.cwd !== 'string' ||
          resolve(init.cwd) !== resolve(directory) ||
          init.permission_mode !== 'request-review' ||
          !Array.isArray(init.tools)
        )
          throw new GatewayError('unsupported', 'Unexpected Antigravity Agent initialization');
        // Verified CLI versions advertise the global catalog here, even for tools:[].
        // Real empty-tools/read-tool controls verified the selected Agent filter.
        initialized = true;
        continue;
      }
      if (!initialized)
        throw new GatewayError('transient', 'Antigravity emitted data before initialization');
      if (event?.event === 'step_update') {
        const step = event.step_update;
        if (
          !step ||
          step.step_type === 'tool' ||
          step.tool_name ||
          step.tool_info ||
          step.subagent_info
        )
          throw new GatewayError('unsupported', 'Unexpected Antigravity tool or subagent step');
        if (!['user_input', 'agent_response', 'checkpoint'].includes(step.step_type))
          throw new GatewayError('transient', 'Unknown Antigravity step type');
        if (step.step_type === 'agent_response' && step.text_delta !== undefined) {
          if (typeof step.text_delta !== 'string')
            throw new GatewayError('transient', 'Invalid Antigravity text delta');
          text += step.text_delta;
          if (step.text_delta) yield { type: 'text', text: step.text_delta };
        }
      } else if (event?.event === 'result') {
        terminal = event.result;
        if (!terminal || terminal.status !== 'SUCCESS')
          throw new GatewayError(failureKind(terminal?.error), 'Antigravity request failed');
        if (
          terminal.num_turns !== 1 ||
          typeof terminal.response !== 'string' ||
          !terminal.response.trim() ||
          !terminal.response.startsWith(text)
        )
          throw new GatewayError(
            'transient',
            'Antigravity terminal response is empty or inconsistent',
          );
      } else throw new GatewayError('transient', 'Unknown Antigravity stream event');
    }
    checkAbort(signal);
    if (!terminal) throw new GatewayError('transient', 'Antigravity stream ended without a result');
    const remainder = terminal.response.slice(text.length);
    if (remainder) yield { type: 'text', text: remainder };
    const u = terminal.usage;
    let usage: Usage | undefined;
    if (
      u &&
      validUsageCount(u.input_tokens) &&
      validUsageCount(u.output_tokens) &&
      validUsageCount(u.total_tokens) &&
      u.total_tokens === u.input_tokens + u.output_tokens
    )
      usage = {
        prompt_tokens: u.input_tokens,
        completion_tokens: u.output_tokens,
        total_tokens: u.total_tokens,
      };
    yield { type: 'done', finishReason: 'stop', ...(usage ? { usage } : {}) };
  } finally {
    await cleanupTemporaryDirectory(directory);
  }
}
