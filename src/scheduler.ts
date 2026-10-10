import type {
  ChatRequest,
  Provider,
  QuotaSnapshot,
  RoutedEvent,
  ProviderEvent,
  Usage,
} from './types.ts';
import { State } from './state.ts';
import { quotaScore, nextReset } from './quota.ts';
import { GatewayError, safeError, abortable } from './errors.ts';
import { validUsage } from './usage.ts';
type Options = {
  timeoutMs?: number;
  quotaTtlMs?: number;
  probeTimeoutMs?: number;
  quotaProbeTimeoutMs?: number;
};
export class Router {
  providers: Provider[];
  state: State;
  timeoutMs: number;
  quotaTtlMs: number;
  probeTimeoutMs: number;
  quotaProbeTimeoutMs: number;
  constructor(providers: Provider[], state: State, options: Options = {}) {
    this.providers = providers;
    this.state = state;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.quotaTtlMs = options.quotaTtlMs ?? 60000;
    this.probeTimeoutMs =
      options.probeTimeoutMs ?? Math.min(3000, Math.max(10, this.timeoutMs / 4));
    this.quotaProbeTimeoutMs =
      options.quotaProbeTimeoutMs ?? Math.min(10000, Math.max(10, this.timeoutMs / 4));
  }
  async *run(request: ChatRequest, parent?: AbortSignal): AsyncGenerator<RoutedEvent> {
    const deadline = Date.now() + this.timeoutMs;
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), this.timeoutMs);
    timer.unref();
    const signal = parent ? AbortSignal.any([parent, control.signal]) : control.signal;
    let lastError: GatewayError | undefined;
    const exhaustedUntil: number[] = [];
    try {
      const pinned =
        request.model === 'auto'
          ? undefined
          : this.providers.find((p) => p.models.some((m) => request.model === p.id + '/' + m));
      if (request.model !== 'auto' && !pinned)
        throw new GatewayError('invalid_request', 'Unknown model alias');
      if (pinned && !pinned.enabled)
        throw new GatewayError(
          'unsupported',
          'Provider ' + pinned.id + ' is disabled or subscription billing has not been verified',
          { providerId: pinned.id },
        );
      type Candidate = {
        provider: Provider;
        model: string;
        score: number | null;
        quota?: QuotaSnapshot;
      };
      const discovered = await Promise.all(
        this.providers.map(async (p): Promise<Candidate | null> => {
          if (!p.enabled || (pinned && p !== pinned)) return null;
          if (!pinned && p.allowAuto === false) return null;
          const model = pinned ? request.model.slice(p.id.length + 1) : p.models[0];
          if (!model) return null;
          const hasHistory =
            request.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length > 1;
          if (
            (request.messages.some((m) => m.role === 'system' || m.role === 'developer') &&
              !p.capabilities.system) ||
            (hasHistory && !p.capabilities.history)
          ) {
            lastError = new GatewayError(
              'unsupported',
              'No provider supports the requested message semantics',
            );
            return null;
          }
          try {
            p.validate?.({ ...request, model });
          } catch (e) {
            lastError = safeError(e);
            return null;
          }
          const block = this.state.getBlock(p.id, model);
          if (block) {
            exhaustedUntil.push(block.until);
            return null;
          }
          let probeSignal = AbortSignal.any([signal, AbortSignal.timeout(this.probeTimeoutMs)]);
          try {
            if (!(await abortable(p.health(probeSignal), probeSignal)).available) {
              lastError = new GatewayError(
                'auth_required',
                'Provider unavailable or requires verification',
              );
              return null;
            }
            const cached = this.state.getQuota(p.id, model);
            if (
              !cached ||
              ((cached.reported?.source ?? cached.source) !== 'manual' &&
                (cached.source === 'unknown' || Date.now() - cached.observedAt > this.quotaTtlMs))
            ) {
              // Account usage commands can take longer than a local CLI health check.
              probeSignal = AbortSignal.any([
                signal,
                AbortSignal.timeout(this.quotaProbeTimeoutMs),
              ]);
              let q: QuotaSnapshot;
              try {
                q = await abortable(p.quota(model, probeSignal), probeSignal);
              } catch {
                if (signal.aborted) throw new GatewayError('cancelled', 'Request cancelled');
                q = {
                  source: 'unknown',
                  observedAt: Date.now(),
                  windows: [],
                  detail: 'Optional quota query failed or timed out; provider remains available',
                };
              }
              this.state.saveQuota(p.id, model, q);
            }
            const q = this.state.getQuota(p.id, model);
            const score = quotaScore(q, Date.now(), this.quotaTtlMs, this.state.count(p.id, model));
            if (score === 0) {
              let reset = nextReset(q);
              if (!reset && (q?.reported?.source ?? q?.source) !== 'manual') {
                reset = Date.now() + this.quotaTtlMs + 1;
                this.state.block(p.id, model, 'quota_exhausted', reset);
              }
              if (reset) exhaustedUntil.push(reset);
              return null;
            }
            return { provider: p, model, score, quota: q };
          } catch (e) {
            if (signal.aborted) throw new GatewayError('cancelled', 'Request cancelled');
            lastError = probeSignal.aborted
              ? new GatewayError('transient', 'Provider health or quota probe timed out')
              : safeError(e);
            return null;
          }
        }),
      );
      const candidates = discovered.filter((p): p is Candidate => p !== null);
      candidates.sort((a, b) => {
        if (a.score === null && b.score !== null) return 1;
        if (a.score !== null && b.score === null) return -1;
        return (
          (b.score ?? 0) - (a.score ?? 0) ||
          a.provider.priority - b.provider.priority ||
          a.provider.id.localeCompare(b.provider.id)
        );
      });
      for (const candidate of candidates) {
        if (signal.aborted) throw new GatewayError('cancelled', 'Request cancelled');
        const p = candidate.provider,
          model = candidate.model;
        if (
          this.state.getBlock(p.id, model) ||
          quotaScore(
            this.state.getQuota(p.id, model),
            Date.now(),
            this.quotaTtlMs,
            this.state.count(p.id, model),
          ) === 0
        )
          continue;
        const cost = {
          requests: p.reservationCosts?.requests ?? 1,
          tokens:
            request.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0) +
            (p.reservationCosts?.outputTokens ?? 4096),
          credits: p.reservationCosts?.credits,
        };
        const lease = this.state.reserve(
          p.id,
          model,
          p.maxConcurrency,
          deadline,
          cost,
          this.quotaTtlMs,
        );
        if (!lease) {
          lastError = new GatewayError(
            'rate_limited',
            'Provider concurrency or estimated budget is busy',
            { retryAt: Date.now() + 1000 },
          );
          continue;
        }
        let committed = false,
          done = false,
          accounted = false,
          bytes = 0,
          events = 0;
        let usage: Usage | undefined;
        const buffered: RoutedEvent[] = [];
        let parts: string[] = [];
        let partBytes = 0;
        const flush = () => {
          if (parts.length) {
            buffered.push({ type: 'text', text: parts.join(''), providerId: p.id, model });
            parts = [];
            partBytes = 0;
          }
        };
        let iterator: AsyncIterator<ProviderEvent> | undefined;
        try {
          iterator = p.invoke({ ...request, model }, signal)[Symbol.asyncIterator]();
          while (true) {
            const step = await abortable(iterator.next(), signal);
            if (step.done) break;
            if (++events > 65536)
              throw new GatewayError('transient', 'Upstream event count exceeds gateway limit');
            const event = step.value;
            if (done)
              throw new GatewayError('transient', 'Upstream emitted events after completion');
            if (event.type === 'text') {
              if (typeof event.text !== 'string')
                throw new GatewayError('transient', 'Invalid upstream text event');
              if (!event.text) continue;
              const size = Buffer.byteLength(event.text);
              bytes += size;
              if (bytes > 16 * 1024 * 1024)
                throw new GatewayError('transient', 'Upstream response exceeds gateway limit');
              if (request.stream) {
                committed = true;
                yield { ...event, providerId: p.id, model };
              } else {
                parts.push(event.text);
                partBytes += size;
                if (parts.length >= 1024 || partBytes >= 65536) flush();
              }
            } else if (event.type === 'done') {
              done = true;
              usage = validUsage(event.usage);
              flush();
              buffered.push({
                type: 'done',
                providerId: p.id,
                model,
                finishReason: event.finishReason ?? 'stop',
                ...(usage ? { usage } : {}),
              });
            } else throw new GatewayError('transient', 'Invalid upstream event');
          }
          if (!done)
            throw new GatewayError('transient', 'Upstream ended without a completion event');
          this.state.consume(p.id, model, usage, cost);
          accounted = true;
          this.state.clearBlock(p.id, model);
          const refreshSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.min(1000, this.probeTimeoutMs)),
          ]);
          try {
            const q = await abortable(p.quota(model, refreshSignal), refreshSignal);
            const current = this.state.getQuota(p.id, model);
            if (
              q.source === 'official' &&
              (current?.reported?.source ?? current?.source) !== 'manual'
            )
              this.state.saveQuota(p.id, model, q);
          } catch {}
          if (signal.aborted) throw new GatewayError('cancelled', 'Request cancelled');
          for (const e of buffered) yield e;
          return;
        } catch (error) {
          if (signal.aborted) throw new GatewayError('cancelled', 'Request cancelled');
          const e = safeError(error);
          lastError = e;
          if (
            e.kind === 'quota_exhausted' ||
            e.kind === 'rate_limited' ||
            e.kind === 'auth_required'
          ) {
            const until =
              e.retryAt ??
              (e.kind === 'quota_exhausted' ? nextReset(candidate.quota) : undefined) ??
              Date.now() + (e.kind === 'auth_required' ? 300000 : 60000);
            this.state.block(p.id, e.kind === 'auth_required' ? '*' : model, e.kind, until);
            exhaustedUntil.push(until);
            e.retryAt = until;
          }
          if (
            committed ||
            e.kind === 'invalid_request' ||
            e.kind === 'unsupported' ||
            e.kind === 'cancelled'
          )
            throw e;
        } finally {
          try {
            if (!accounted) this.state.consume(p.id, model, usage, cost);
          } finally {
            this.state.release(lease);
            if (iterator?.return) void iterator.return().catch(() => {});
          }
        }
      }
      if (lastError) throw lastError;
      throw new GatewayError('quota_exhausted', 'No eligible subscription has available quota', {
        retryAt: exhaustedUntil.length ? Math.min(...exhaustedUntil) : undefined,
      });
    } finally {
      clearTimeout(timer);
      control.abort();
    }
  }
}
