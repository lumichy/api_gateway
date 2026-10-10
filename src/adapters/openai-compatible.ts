import { GatewayError } from '../errors.ts';
import type { ChatRequest, ProviderEvent } from '../types.ts';
import { checkAbort, httpError } from './http.ts';
import { compatibleResponse } from './compatible-response.ts';

export type OpenAICompatibleConfig = { id: string; baseUrl: string; apiKeyEnv: string };

export function compatibleEndpoint(config: OpenAICompatibleConfig): string {
  try {
    const url = new URL(config.baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid URL');
    return url.href.replace(/\/+$/, '') + '/chat/completions';
  } catch {
    throw new GatewayError('unsupported', 'OpenAI-compatible provider requires a valid baseUrl', {
      providerId: config.id,
    });
  }
}

export async function* compatibleInvoke(
  config: OpenAICompatibleConfig,
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  checkAbort(signal);
  const endpoint = compatibleEndpoint(config);
  const key = process.env[config.apiKeyEnv];
  if (!key)
    throw new GatewayError('auth_required', 'API key environment variable is missing', {
      providerId: config.id,
    });
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw await httpError(response, config.id);
    yield* compatibleResponse(response, request.stream, signal);
  } catch (error) {
    checkAbort(signal);
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('transient', 'OpenAI-compatible API transport failed', {
      providerId: config.id,
    });
  }
}
