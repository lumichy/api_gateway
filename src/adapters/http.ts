import { GatewayError } from '../errors.ts';
import type { ProviderEvent, Usage } from '../types.ts';
export function validUsageCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new GatewayError('cancelled', 'Request cancelled');
}
export async function httpError(response: Response, providerId?: string) {
  let body = '';
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let received = 0;
    try {
      while (received < 8192) {
        const { value, done } = await reader.read();
        if (done) break;
        const slice = value.subarray(0, 8192 - received);
        received += slice.byteLength;
        body += decoder.decode(slice, { stream: true });
      }
      body += decoder.decode();
    } catch {
      /* Body failure must not hide the HTTP status. */
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  let code = '';
  let inFlightBudget = false;
  try {
    const parsed = JSON.parse(body);
    code = String(parsed.error?.code ?? parsed.error?.type ?? '');
    inFlightBudget = parsed.error?.metadata?.limit_source === 'openrouter_in_flight_budget';
  } catch {}
  const quota = /quota|credit|budget|balance|subscription.*exhaust/i.test(code);
  const kind =
    response.status === 401 || response.status === 403
      ? 'auth_required'
      : response.status === 402
        ? inFlightBudget
          ? 'rate_limited'
          : 'quota_exhausted'
        : response.status === 408
          ? 'transient'
          : response.status === 429
            ? quota
              ? 'quota_exhausted'
              : 'rate_limited'
            : response.status >= 500
              ? 'transient'
              : 'invalid_request';
  const retry = response.headers.get('retry-after');
  let retryAt: number | undefined;
  if (retry) {
    const seconds = Number(retry);
    retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry);
    if (!Number.isFinite(retryAt)) retryAt = undefined;
  }
  return new GatewayError(kind, 'Provider returned HTTP ' + response.status, {
    status: response.status,
    retryAt,
    providerId,
  });
}
export async function* sse(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  checkAbort(signal);
  if (!response.body) throw new GatewayError('transient', 'Missing stream body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let frameBytes = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      checkAbort(signal);
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Process complete lines, preserving CRLF even when CR and LF are separate chunks.
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newline);
        const line = rawLine.replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        frameBytes += Buffer.byteLength(rawLine, 'utf8') + 1;
        if (frameBytes > 1048576)
          throw new GatewayError('transient', 'Stream frame exceeded limit');
        if (line === '') {
          if (data.length) {
            yield data.join('\n');
            data = [];
          }
          frameBytes = 0;
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (frameBytes + Buffer.byteLength(buffer, 'utf8') > 1048576)
        throw new GatewayError('transient', 'Stream frame exceeded limit');
      if (done) break;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function* openAIStream(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  let usage: Usage | undefined;
  let finishReason: 'stop' | 'length' = 'stop';
  for await (const data of sse(response, signal)) {
    if (data === '[DONE]') {
      yield { type: 'done', finishReason, ...(usage ? { usage } : {}) };
      return;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new GatewayError('transient', 'Invalid provider stream JSON');
    }
    if (chunk.error) {
      const rawStatus = chunk.error.status ?? chunk.error.code;
      const numericStatus =
        typeof rawStatus === 'number'
          ? rawStatus
          : /^\d{3}$/.test(String(rawStatus))
            ? Number(rawStatus)
            : NaN;
      const status =
        Number.isInteger(numericStatus) && numericStatus >= 400 && numericStatus <= 599
          ? numericStatus
          : chunk.error.code === 'insufficient_quota'
            ? 429
            : 500;
      throw await httpError(new Response(JSON.stringify(chunk), { status }));
    }
    if (
      chunk.usage &&
      ['prompt_tokens', 'completion_tokens', 'total_tokens'].every((k) =>
        validUsageCount(chunk.usage[k]),
      )
    )
      usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.delta?.tool_calls)
      throw new GatewayError('unsupported', 'Provider unexpectedly attempted tool calls');
    if (typeof choice?.delta?.content === 'string' && choice.delta.content)
      yield { type: 'text', text: choice.delta.content };
    if (choice?.finish_reason === 'length') finishReason = 'length';
  }
  throw new GatewayError('transient', 'Provider stream ended without completion marker');
}
