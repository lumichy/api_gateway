import { GatewayError } from '../errors.ts';
import type { Provider, ChatRequest, QuotaSnapshot, ProviderEvent, ErrorKind } from '../types.ts';
import { checkAbort } from './http.ts';
import { compatibleEndpoint, compatibleInvoke } from './openai-compatible.ts';
import { singleTurn } from './subprocess.ts';
import { claudeInvoke, claudeHealth } from './claude.ts';
import { codebuddyInvoke, codebuddyHealth } from './codebuddy.ts';
import { responsesInvoke, responsesBody } from './responses.ts';
import { codexQuota } from './codex.ts';
import { antigravityHealth, antigravityInvoke } from './antigravity.ts';
import { codexExecHealth, codexExecInvoke } from './codex-exec.ts';
import { openrouterQuota, unknownQuota } from './quota-telemetry.ts';
import { antigravityQuota } from './antigravity-quota.ts';
import { createClaudeQuotaTelemetry } from './claude-quota.ts';
import { arkQuota } from './ark-quota.ts';
import { requireTextRequest } from '../chat-request.ts';
export type ProviderConfig = {
  id: string;
  type: 'openai-compatible' | 'codex' | 'claude' | 'codebuddy' | 'antigravity' | 'demo';
  models: string[];
  enabled?: boolean;
  priority?: number;
  maxConcurrency?: number;
  billingVerified?: boolean;
  allowAuto?: boolean;
  apiKeyEnv?: string;
  baseUrl?: string;
  command?: string;
  args?: string[];
  mode?: 'app-server' | 'responses' | 'exec';
  tokenEnv?: string;
  approvedHooksSha256?: string;
  quotaSource?: 'openrouter' | 'ark-cli';
  quotaCommand?: string;
  demo?: { remaining?: number | null; fail?: string; text?: string };
};
const blocked: Partial<Record<ProviderConfig['type'], string>> = {
  codex:
    'Codex app-server inference unavailable: a verified all-tools-disabled configuration is required.',
};
export function createProvider(config: ProviderConfig): Provider {
  const claudeTelemetry = createClaudeQuotaTelemetry();
  const direct = config.type === 'codex' && config.mode === 'responses';
  const http = config.type === 'openai-compatible';
  const httpConfig = {
    id: config.id,
    baseUrl: config.baseUrl!,
    apiKeyEnv: config.apiKeyEnv!,
  };
  if (http) {
    compatibleEndpoint(httpConfig);
    if (!httpConfig.apiKeyEnv || !/^[A-Z_][A-Z0-9_]*$/.test(httpConfig.apiKeyEnv))
      throw new GatewayError('unsupported', 'API provider requires an apiKeyEnv reference', {
        providerId: config.id,
      });
  }
  const exec = config.type === 'codex' && config.mode === 'exec';
  const enabled =
    config.type === 'demo'
      ? (config.enabled ?? true)
      : config.enabled === true && config.billingVerified === true;
  const base = {
    id: config.id,
    models: [...config.models],
    enabled,
    allowAuto: config.allowAuto ?? config.type !== 'openai-compatible',
    priority: config.priority ?? 100,
    maxConcurrency: config.maxConcurrency ?? 1,
    capabilities: {
      system:
        direct ||
        exec ||
        config.type === 'demo' ||
        http ||
        config.type === 'claude' ||
        config.type === 'codebuddy' ||
        config.type === 'antigravity',
      history: direct || config.type === 'demo' || http,
      chat: http,
    },
  };
  const guard = (signal: AbortSignal) => {
    checkAbort(signal);
    if (!enabled)
      throw new GatewayError(
        'unsupported',
        'Provider disabled or subscription billing has not been verified',
        { providerId: config.id },
      );
  };
  return {
    ...base,
    validate(request: ChatRequest) {
      if (!http) requireTextRequest(request);
      if (direct) {
        responsesBody(request);
        return;
      }
      if (
        exec ||
        config.type === 'claude' ||
        config.type === 'codebuddy' ||
        config.type === 'antigravity'
      ) {
        singleTurn(request);
        return;
      }
      if (blocked[config.type])
        throw new GatewayError('unsupported', blocked[config.type]!, { providerId: config.id });
    },
    async health(signal = new AbortController().signal) {
      checkAbort(signal);
      if (!enabled)
        return {
          available: false,
          detail: 'Disabled; explicit enable and verified subscription billing required',
        };
      if (direct)
        return {
          available: !!(config.tokenEnv && process.env[config.tokenEnv]),
          detail:
            'App-authorized SIWC token required; subscription billing and model entitlement unverified live',
        };
      if (exec) return codexExecHealth(config, signal);
      if (blocked[config.type]) return { available: false, detail: blocked[config.type] };
      if (config.type === 'antigravity') return antigravityHealth(config, signal);
      if (http)
        return {
          available: !!process.env[httpConfig.apiKeyEnv],
          detail: 'API key configured; connectivity and quota not tested',
        };
      if (config.type === 'claude') return claudeHealth(config, signal);
      if (config.type === 'codebuddy') return codebuddyHealth(config, signal);
      return { available: true, detail: 'Local demo' };
    },
    async quota(_model, signal) {
      checkAbort(signal);
      if (config.type === 'demo')
        return {
          source: 'manual',
          observedAt: Date.now(),
          windows: [{ unit: 'requests', remaining: config.demo?.remaining ?? null, resetAt: null }],
        };
      if (config.type === 'codex' && !direct && enabled) return codexQuota(config, signal);
      if (config.type === 'antigravity' && enabled) return antigravityQuota(config, _model, signal);
      if (config.type === 'claude' && enabled) return claudeTelemetry.read(_model);
      if (config.quotaSource === 'openrouter' && enabled)
        return openrouterQuota(config, _model, signal);
      if (config.quotaSource === 'ark-cli' && enabled) return arkQuota(config, signal);
      return unknownQuota(
        config.type === 'codebuddy'
          ? 'Official CLI has no supported account credit balance query; use the account Usage page'
          : config.type === 'claude'
            ? 'Official CLI exposes usage windows after an API response, not a fresh read-only quota query'
            : 'Quota telemetry is not configured',
      );
    },
    async *invoke(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
      guard(signal);
      if (!config.models.includes(request.model))
        throw new GatewayError('unsupported', 'Model not configured', { providerId: config.id });
      if (direct) {
        yield* responsesInvoke(config, request, signal);
        return;
      }
      if (exec) {
        yield* codexExecInvoke(config, request, signal);
        return;
      }
      if (blocked[config.type])
        throw new GatewayError('unsupported', blocked[config.type]!, { providerId: config.id });
      if (config.type === 'demo') {
        if (config.demo?.fail)
          throw new GatewayError(config.demo.fail as ErrorKind, 'Configured demo failure', {
            providerId: config.id,
          });
        yield {
          type: 'text',
          text:
            config.demo?.text ??
            'Demo response: ' + request.messages.filter((m) => m.role === 'user').at(-1)?.content,
        };
        checkAbort(signal);
        yield { type: 'done', finishReason: 'stop' };
        return;
      }
      if (config.type === 'claude') {
        yield* claudeInvoke(config, request, signal, (event) =>
          claudeTelemetry.observe(event, request.model),
        );
        return;
      }
      if (config.type === 'codebuddy') {
        yield* codebuddyInvoke(config, request, signal);
        return;
      }
      if (config.type === 'antigravity') {
        yield* antigravityInvoke(config, request, signal);
        return;
      }
      yield* compatibleInvoke(httpConfig, request, signal);
    },
  };
}
