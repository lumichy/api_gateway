import type { ErrorKind } from './types.ts';
export class GatewayError extends Error {
  kind: ErrorKind;
  status: number;
  retryAt?: number;
  providerId?: string;
  constructor(
    kind: ErrorKind,
    message: string,
    options: { status?: number; retryAt?: number; providerId?: string } = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.kind = kind;
    this.status =
      options.status ??
      {
        quota_exhausted: 429,
        rate_limited: 429,
        auth_required: 503,
        transient: 502,
        invalid_request: 400,
        unsupported: 400,
        cancelled: 499,
      }[kind];
    this.retryAt = options.retryAt;
    this.providerId = options.providerId;
  }
}
export function safeError(error: unknown): GatewayError {
  return error instanceof GatewayError
    ? error
    : new GatewayError('transient', 'Upstream request failed');
}
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(new GatewayError('cancelled', 'Request cancelled'));
  }
  return new Promise((resolve, reject) => {
    const stop = () => {
      cleanup();
      reject(new GatewayError('cancelled', 'Request cancelled'));
    };
    const cleanup = () => signal.removeEventListener('abort', stop);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
