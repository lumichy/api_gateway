import { GatewayError } from './errors.ts';
import type { ChatRequest, Message } from './types.ts';

export function validateChatRequest(value: any): ChatRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayError('invalid_request', 'Expected JSON object');
  if (typeof value.model !== 'string' || !value.model || value.model.length > 256)
    throw new GatewayError('invalid_request', 'model must be a nonempty string');
  if (value.stream !== undefined && typeof value.stream !== 'boolean')
    throw new GatewayError('invalid_request', 'stream must be boolean');
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 512)
    throw new GatewayError('invalid_request', 'messages must contain 1 to 512 messages');
  for (const m of value.messages) {
    if (
      !m ||
      typeof m !== 'object' ||
      Array.isArray(m) ||
      !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(m.role) ||
      !(
        typeof m.content === 'string' ||
        (Array.isArray(m.content) &&
          m.content.every(
            (p: any) =>
              p && typeof p === 'object' && !Array.isArray(p) && typeof p.type === 'string',
          )) ||
        (m.role === 'assistant' && m.content == null)
      )
    )
      throw new GatewayError('invalid_request', 'Invalid message role or content');
    if (m.role === 'tool' && (typeof m.tool_call_id !== 'string' || !m.tool_call_id))
      throw new GatewayError('invalid_request', 'tool message requires tool_call_id');
  }
  for (const key of ['n', 'max_tokens', 'max_completion_tokens'])
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1))
      throw new GatewayError('invalid_request', key + ' must be a positive safe integer');
  const output = Math.max(value.max_tokens ?? 0, value.max_completion_tokens ?? 0, 4096);
  if (!Number.isSafeInteger(output * (value.n ?? 1)))
    throw new GatewayError('invalid_request', 'Requested output budget is too large');
  return { ...value, stream: value.stream ?? false };
}

export function requireTextRequest(request: ChatRequest): asserts request is ChatRequest & {
  messages: (Message & { content: string })[];
} {
  const parameter = Object.keys(request).find((k) => !['model', 'messages', 'stream'].includes(k));
  if (parameter)
    throw new GatewayError(
      'unsupported',
      'This text adapter does not support request parameter: ' + parameter,
    );
  if (
    request.messages.some(
      (m) =>
        typeof m.content !== 'string' ||
        !['system', 'developer', 'user', 'assistant'].includes(m.role) ||
        Object.keys(m).some((k) => !['role', 'content'].includes(k)),
    )
  )
    throw new GatewayError('unsupported', 'This adapter supports plain text messages only');
}

export function requestTokenBudget(request: ChatRequest, defaultOutput: number): number {
  let input: number;
  try {
    requireTextRequest(request);
    input = request.messages.reduce((n, m) => n + Buffer.byteLength(m.content as string), 0);
  } catch {
    input = Buffer.byteLength(JSON.stringify(request));
  }
  const output =
    Math.max(request.max_completion_tokens ?? 0, request.max_tokens ?? 0) || defaultOutput;
  const budget = input + output * (request.n ?? 1);
  if (!Number.isSafeInteger(budget))
    throw new GatewayError('invalid_request', 'Requested token budget is too large');
  return budget;
}
