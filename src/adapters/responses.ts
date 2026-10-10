import { GatewayError } from '../errors.ts';
import { checkAbort, httpError, sse, validUsageCount } from './http.ts';
import type { ChatRequest, ProviderEvent } from '../types.ts';
import type { ProviderConfig } from './index.ts';
import { requireTextRequest } from '../chat-request.ts';
export function responsesBody(request: ChatRequest) {
  requireTextRequest(request);
  const messages = request.messages;
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  const input = system ? messages.slice(1) : messages;
  if (input.some((m) => m.role === 'system'))
    throw new GatewayError('unsupported', 'SIWC supports only one leading system instruction');
  return {
    model: request.model,
    ...(system ? { instructions: system.content } : {}),
    input,
    store: false,
    stream: true,
    tools: [],
    tool_choice: 'none',
  };
}
export async function* responsesStream(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  for await (const data of sse(response, signal)) {
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      throw new GatewayError('transient', 'Invalid Responses stream event');
    }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string')
      yield { type: 'text', text: event.delta };
    if (
      event.type === 'response.output_item.added' &&
      event.item?.type &&
      event.item.type !== 'message' &&
      event.item.type !== 'reasoning'
    )
      throw new GatewayError(
        'unsupported',
        'Unexpected tool output in tool-free Responses request',
      );
    if (event.type === 'response.failed' || event.type === 'error') {
      const error = event.response?.error ?? event.error ?? event;
      const code = String(error.code ?? error.type ?? '');
      // In-stream failures usually omit an HTTP status. Their protocol code is
      // authoritative even though the outer HTTP stream was initially successful.
      const status = /insufficient_quota|quota|credit.*exhaust|budget.*exceed/i.test(code)
        ? 429
        : /rate.?limit|too_many_requests/i.test(code)
          ? 429
          : /invalid_api_key|authentication|auth_required|token.*expired|invalid_token/i.test(code)
            ? 401
            : (event.status ?? error.status ?? 500);
      throw await httpError(new Response(JSON.stringify({ error }), { status }));
    }
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const u = event.response?.usage;
      const usage =
        u && ['input_tokens', 'output_tokens', 'total_tokens'].every((k) => validUsageCount(u[k]))
          ? {
              prompt_tokens: u.input_tokens,
              completion_tokens: u.output_tokens,
              total_tokens: u.total_tokens,
            }
          : undefined;
      yield {
        type: 'done',
        finishReason: event.type === 'response.incomplete' ? 'length' : 'stop',
        ...(usage ? { usage } : {}),
      };
      return;
    }
  }
  throw new GatewayError('transient', 'Responses stream ended before completion');
}
export async function* responsesInvoke(
  config: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
) {
  const body = responsesBody(request);
  const token = config.tokenEnv ? process.env[config.tokenEnv] : undefined;
  if (!token)
    throw new GatewayError(
      'auth_required',
      'An app-authorized SIWC access token must be supplied via tokenEnv',
      { providerId: config.id },
    );
  if (token.startsWith('sk-'))
    throw new GatewayError(
      'unsupported',
      'SIWC subscription route does not accept billed API keys',
      { providerId: config.id },
    );
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await httpError(response, config.id);
    yield* responsesStream(response, signal);
  } catch (e) {
    checkAbort(signal);
    if (e instanceof GatewayError) throw e;
    throw new GatewayError('transient', 'SIWC transport failed', { providerId: config.id });
  }
}
