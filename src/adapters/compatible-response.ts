import type { ChatJSON, ProviderEvent } from '../types.ts';
import { GatewayError } from '../errors.ts';
import { validUsage } from '../usage.ts';
import { checkAbort, httpError, sse } from './http.ts';

const invalid = () => new GatewayError('transient', 'Invalid compatible API response');
async function checkError(body: ChatJSON) {
  if (!body.error) return;
  const error = body.error;
  const rawStatus = Number(error.status ?? error.code);
  const status =
    Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
      ? rawStatus
      : /quota|credit|budget/i.test(String(error.code ?? error.type))
        ? 429
        : /auth|invalid_api_key/i.test(String(error.code ?? error.type))
          ? 401
          : /rate.?limit/i.test(String(error.code ?? error.type))
            ? 429
            : 500;
  throw await httpError(new Response(JSON.stringify(body), { status }));
}
function choices(body: any, streaming: boolean): asserts body is ChatJSON {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Array.isArray(body.choices) ||
    (!streaming && !body.choices.length)
  )
    throw invalid();
  const indexes = new Set<number>();
  for (const choice of body.choices) {
    const payload = streaming ? choice?.delta : choice?.message;
    if (
      !Number.isSafeInteger(choice?.index) ||
      choice.index < 0 ||
      indexes.has(choice.index) ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      (choice.finish_reason != null && typeof choice.finish_reason !== 'string') ||
      (!streaming && (payload.role !== 'assistant' || typeof choice.finish_reason !== 'string'))
    )
      throw invalid();
    indexes.add(choice.index);
  }
}
function sanitizedUsage(body: ChatJSON): ChatJSON {
  if (body.usage != null && !validUsage(body.usage)) {
    const { usage: _usage, ...rest } = body;
    return rest;
  }
  return body;
}
async function readJSON(response: Response, signal: AbortSignal): Promise<ChatJSON> {
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      checkAbort(signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024)
        throw new GatewayError('transient', 'API response exceeds gateway limit');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw invalid();
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function* compatibleResponse(
  response: Response,
  stream: boolean,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  if (!stream) {
    const body = await readJSON(response, signal);
    if (!body || typeof body !== 'object') throw invalid();
    await checkError(body);
    choices(body, false);
    yield { type: 'chat_response', body: sanitizedUsage(body) };
    yield { type: 'done', ...(validUsage(body.usage) ? { usage: validUsage(body.usage) } : {}) };
    return;
  }
  let usage;
  const started = new Set<number>();
  const finished = new Set<number>();
  for await (const data of sse(response, signal)) {
    if (data === '[DONE]') {
      if (!started.size || [...started].some((index) => !finished.has(index))) throw invalid();
      yield { type: 'done', ...(usage ? { usage } : {}) };
      return;
    }
    let body;
    try {
      body = JSON.parse(data);
    } catch {
      throw invalid();
    }
    if (!body || typeof body !== 'object') throw invalid();
    await checkError(body);
    choices(body, true);
    for (const choice of body.choices) {
      started.add(choice.index);
      if (choice.finish_reason != null) finished.add(choice.index);
    }
    if (validUsage(body.usage)) usage = validUsage(body.usage);
    yield { type: 'chat_chunk', body: sanitizedUsage(body) };
  }
  throw new GatewayError('transient', 'Provider stream ended without completion marker');
}
