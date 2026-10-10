import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Router } from './scheduler.ts';
import { State } from './state.ts';
import { GatewayError, safeError, abortable } from './errors.ts';
import type { ChatRequest, Provider, QuotaSnapshot, QuotaWindow } from './types.ts';
export type GatewayOptions = {
  providers: Provider[];
  state: State;
  gatewayKey: string;
  adminKey: string;
  timeoutMs?: number;
  quotaTtlMs?: number;
};
function authorize(req: IncomingMessage, key: string) {
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + key);
  if (!key || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new GatewayError('auth_required', 'Invalid gateway credentials', { status: 401 });
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
function errorBody(e: GatewayError) {
  return {
    error: {
      message: e.message,
      type:
        e.status === 401
          ? 'authentication_error'
          : e.status === 400
            ? 'invalid_request_error'
            : e.status === 429
              ? 'rate_limit_error'
              : 'server_error',
      param: null,
      code: e.kind,
    },
  };
}
async function body(req: IncomingMessage): Promise<any> {
  let bytes = 0;
  const buffers: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024)
      throw new GatewayError('invalid_request', 'Request body exceeds 1 MiB', { status: 413 });
    buffers.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(buffers).toString('utf8'));
  } catch {
    throw new GatewayError('invalid_request', 'Invalid JSON body');
  }
}
export function validateRequest(value: any): ChatRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayError('invalid_request', 'Expected JSON object');
  for (const key of Object.keys(value))
    if (!['model', 'messages', 'stream'].includes(key))
      throw new GatewayError('unsupported', 'Unsupported request parameter: ' + key);
  if (typeof value.model !== 'string' || value.model.length > 256 || !value.model)
    throw new GatewayError('invalid_request', 'model must be a nonempty string');
  if (value.stream !== undefined && typeof value.stream !== 'boolean')
    throw new GatewayError('invalid_request', 'stream must be boolean');
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 512)
    throw new GatewayError('invalid_request', 'messages must contain 1 to 512 text messages');
  const messages = value.messages.map((m: any) => {
    if (
      !m ||
      typeof m !== 'object' ||
      Array.isArray(m) ||
      Object.keys(m).some((k) => !['role', 'content'].includes(k)) ||
      !['system', 'developer', 'user', 'assistant'].includes(m.role) ||
      typeof m.content !== 'string'
    )
      throw new GatewayError(
        'unsupported',
        'Only text system, developer, user and assistant messages are supported',
      );
    return { role: m.role, content: m.content };
  });
  return { model: value.model, messages, stream: value.stream ?? false };
}
export function validateQuota(
  value: any,
  providers: Provider[],
): { provider: string; model: string; quota: QuotaSnapshot } {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((k) => !['provider', 'model', 'pool', 'windows'].includes(k))
  )
    throw new GatewayError('invalid_request', 'Invalid quota fields');
  const p = providers.find((p) => p.id === value.provider);
  if (!p || !p.models.includes(value.model))
    throw new GatewayError('invalid_request', 'Unknown provider/model');
  if (
    value.pool !== undefined &&
    (typeof value.pool !== 'string' || !value.pool || value.pool.length > 128)
  )
    throw new GatewayError('invalid_request', 'Invalid pool name');
  if (!Array.isArray(value.windows) || value.windows.length < 1 || value.windows.length > 16)
    throw new GatewayError('invalid_request', 'windows must contain 1 to 16 quota windows');
  const windows: QuotaWindow[] = value.windows.map((w: any) => {
    if (
      !w ||
      typeof w !== 'object' ||
      Object.keys(w).some(
        (k) => !['unit', 'remaining', 'limit', 'usedPercent', 'resetAt'].includes(k),
      ) ||
      !['requests', 'tokens', 'credits', 'percent'].includes(w.unit)
    )
      throw new GatewayError('invalid_request', 'Invalid quota window');
    for (const k of ['remaining', 'limit', 'usedPercent', 'resetAt'])
      if (
        w[k] !== undefined &&
        w[k] !== null &&
        (typeof w[k] !== 'number' || !Number.isFinite(w[k]) || w[k] < 0)
      )
        throw new GatewayError(
          'invalid_request',
          'Quota values must be finite nonnegative numbers or null',
        );
    if (w.remaining === undefined && w.usedPercent === undefined)
      throw new GatewayError('invalid_request', 'A remaining balance or usedPercent is required');
    if (w.usedPercent !== undefined && w.usedPercent !== null && w.usedPercent > 100)
      throw new GatewayError('invalid_request', 'usedPercent must be at most 100');
    if (
      w.unit === 'percent' &&
      w.remaining !== undefined &&
      w.remaining !== null &&
      w.remaining > 100
    )
      throw new GatewayError('invalid_request', 'Percent remaining must be at most 100');
    return {
      unit: w.unit,
      remaining: w.remaining ?? null,
      limit: w.limit ?? null,
      usedPercent: w.usedPercent ?? null,
      resetAt: w.resetAt ?? null,
    };
  });
  return {
    provider: p.id,
    model: value.model,
    quota: { source: 'manual', observedAt: Date.now(), pool: value.pool, windows },
  };
}
async function write(res: ServerResponse, data: string, signal: AbortSignal) {
  if (signal.aborted || res.destroyed) throw new GatewayError('cancelled', 'Client disconnected');
  if (!res.write(data)) await once(res, 'drain', { signal });
}
export function createGateway(options: GatewayOptions) {
  const router = new Router(options.providers, options.state, options);
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    const control = new AbortController();
    const deadline = setTimeout(() => control.abort(), options.timeoutMs ?? 120000);
    deadline.unref();
    const abort = () => {
      if (!res.writableFinished) control.abort();
    };
    req.on('aborted', abort);
    res.on('close', abort);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') {
        json(res, 200, { status: 'ok' });
        return;
      }
      if (url.pathname.startsWith('/admin/')) {
        authorize(req, options.adminKey);
        if (url.pathname === '/admin/status' && req.method === 'GET') {
          const providers = await Promise.all(
            options.providers.map(async (p) => {
              let available = false;
              try {
                const probe = AbortSignal.timeout(3000);
                available = (await abortable(p.health(probe), probe)).available;
              } catch {}
              return {
                id: p.id,
                models: p.models,
                enabled: p.enabled,
                available,
                capabilities: p.capabilities,
              };
            }),
          );
          json(res, 200, { providers, ...options.state.status() });
          return;
        }
        if (url.pathname === '/admin/quota' && req.method === 'POST') {
          const value = validateQuota(await body(req), options.providers);
          options.state.saveQuota(value.provider, value.model, value.quota);
          json(res, 200, { status: 'saved', source: 'manual' });
          return;
        }
        if (url.pathname === '/admin/quota/refresh' && req.method === 'POST') {
          const b = await body(req);
          if (
            !b ||
            typeof b !== 'object' ||
            Array.isArray(b) ||
            Object.keys(b).some((k) => !['provider', 'model'].includes(k)) ||
            (b.provider !== undefined && !options.providers.some((p) => p.id === b.provider)) ||
            (b.model !== undefined &&
              (b.provider === undefined ||
                !options.providers.find((p) => p.id === b.provider)?.models.includes(b.model)))
          )
            throw new GatewayError('invalid_request', 'Invalid quota refresh provider/model');
          const providers = await Promise.all(
            options.providers
              .filter((p) => b.provider === undefined || p.id === b.provider)
              .map(async (p) => {
                const model: string = b.model ?? p.models[0];
                let quota: QuotaSnapshot;
                try {
                  const probe = AbortSignal.any([control.signal, AbortSignal.timeout(10000)]);
                  quota = p.enabled
                    ? await abortable(p.quota(model, probe), probe)
                    : {
                        source: 'unknown',
                        observedAt: Date.now(),
                        windows: [],
                        detail: 'Provider disabled',
                      };
                } catch {
                  quota = {
                    source: 'unknown',
                    observedAt: Date.now(),
                    windows: [],
                    detail: 'Quota query failed or timed out',
                  };
                }
                const cached = options.state.getQuota(p.id, model);
                const manual = (cached?.reported?.source ?? cached?.source) === 'manual';
                const written = !manual && options.state.saveQuota(p.id, model, quota);
                const saved = written && quota.source !== 'unknown';
                return {
                  id: p.id,
                  model,
                  quota,
                  saved,
                  effectiveQuota: options.state.getQuota(p.id, model),
                };
              }),
          );
          json(res, 200, { providers });
          return;
        }
        if (url.pathname === '/admin/unblock' && req.method === 'POST') {
          const b = await body(req);
          const p = options.providers.find((p) => p.id === b?.provider);
          if (!p || !p.models.includes(b?.model))
            throw new GatewayError('invalid_request', 'Unknown provider/model');
          options.state.reset(p.id, b.model);
          json(res, 200, { status: 'reset' });
          return;
        }
        json(res, 404, {
          error: {
            message: 'Unknown management endpoint',
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
        return;
      }
      authorize(req, options.gatewayKey);
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        json(res, 200, {
          object: 'list',
          data: [
            { id: 'auto', object: 'model', created: 0, owned_by: 'gateway' },
            ...options.providers
              .filter((p) => p.enabled)
              .flatMap((p) =>
                p.models.map((m) => ({
                  id: p.id + '/' + m,
                  object: 'model',
                  created: 0,
                  owned_by: p.id,
                })),
              ),
          ],
        });
        return;
      }
      if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
        json(res, 404, {
          error: {
            message: 'Endpoint is not supported; use /v1/chat/completions',
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
        return;
      }
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
        throw new GatewayError('invalid_request', 'Content-Type must be application/json', {
          status: 415,
        });
      const chat = validateRequest(await body(req));
      const id = 'chatcmpl-' + requestId;
      const created = Math.floor(Date.now() / 1000);
      let text = '',
        usage: any,
        finishReason = 'stop';
      let started = false;
      for await (const event of router.run(chat, control.signal)) {
        if (!started) {
          res.setHeader('x-gateway-provider', event.providerId);
          res.setHeader('x-gateway-model', event.model);
          started = true;
          if (chat.stream) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            });
            await write(
              res,
              'data: ' +
                JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model: chat.model,
                  choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                }) +
                '\n\n',
              control.signal,
            );
          }
        }
        if (event.type === 'text') {
          if (chat.stream)
            await write(
              res,
              'data: ' +
                JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model: chat.model,
                  choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
                }) +
                '\n\n',
              control.signal,
            );
          else text += event.text;
        } else {
          usage = event.usage;
          finishReason = event.finishReason ?? 'stop';
        }
      }
      if (chat.stream) {
        await write(
          res,
          'data: ' +
            JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: chat.model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
              ...(usage ? { usage } : {}),
            }) +
            '\n\ndata: [DONE]\n\n',
          control.signal,
        );
        res.end();
      } else
        json(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: chat.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: text },
              finish_reason: finishReason,
            },
          ],
          ...(usage ? { usage } : {}),
        });
    } catch (error) {
      if (res.destroyed) return;
      if (control.signal.aborted && res.headersSent) {
        res.destroy();
        return;
      }
      const e = safeError(error);
      if (res.headersSent) {
        res.end('data: ' + JSON.stringify(errorBody(e)) + '\n\ndata: [DONE]\n\n');
      } else {
        if (e.retryAt)
          res.setHeader(
            'retry-after',
            String(Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000))),
          );
        json(res, e.status === 499 ? 408 : e.status, errorBody(e));
      }
    } finally {
      clearTimeout(deadline);
      req.off('aborted', abort);
      res.off('close', abort);
      control.abort();
    }
  });
  server.timeout = options.timeoutMs ?? 120000;
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.maxHeadersCount = 64;
  return server;
}
