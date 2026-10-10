import type { QuotaSnapshot, QuotaWindow } from '../types.ts';

const windowTypes = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;
type WindowType = (typeof windowTypes)[number];
const family = (model: string) =>
  /^(?:claude-)?sonnet(?:-|$)/i.test(model)
    ? 'sonnet'
    : /^(?:claude-)?opus(?:-|$)/i.test(model)
      ? 'opus'
      : undefined;

// Standard SDK fields plus unifiedWindows verified live on pinned CLI 2.1.296.
// CLI upgrades must reverify this wire shape; no separate model call is made here.
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/message_parser.py
export function createClaudeQuotaTelemetry() {
  const windows = new Map<WindowType, { observedAt: number; window: QuotaWindow }>();
  const record = (type: WindowType, info: any, model: string, now: number) => {
    if (type.startsWith('seven_day_') && type !== `seven_day_${family(model)}`) return;
    const resetAt = typeof info?.resetsAt === 'number' ? info.resetsAt * 1000 : NaN;
    const utilization =
      info?.status === 'rejected' && info.utilization == null ? 1 : info?.utilization;
    if (
      typeof utilization !== 'number' ||
      !Number.isFinite(utilization) ||
      utilization < 0 ||
      utilization > 1 ||
      !Number.isFinite(resetAt) ||
      resetAt <= now ||
      (info?.status === 'rejected' && utilization !== 1)
    ) {
      windows.delete(type);
      return;
    }
    windows.set(type, {
      observedAt: now,
      window: {
        name: type,
        observedAt: now,
        unit: 'percent',
        limit: 100,
        remaining: (1 - utilization) * 100,
        usedPercent: utilization * 100,
        resetAt,
      },
    });
  };
  return {
    observe(event: unknown, model: string): void {
      const v = event as any;
      if (v?.type !== 'rate_limit_event' || !v.rate_limit_info) return;
      const info = v.rate_limit_info;
      const type = info.rateLimitType as WindowType;
      if (
        !windowTypes.includes(type) ||
        !['allowed', 'allowed_warning', 'rejected'].includes(info.status)
      )
        return;
      const now = Date.now();
      const unified = info.unifiedWindows;
      const structured = unified && typeof unified === 'object' && !Array.isArray(unified);
      if (structured) {
        for (const windowType of windowTypes) {
          if (Object.hasOwn(unified, windowType))
            record(
              windowType,
              {
                utilization: unified[windowType]?.utilization,
                resetsAt: unified[windowType]?.resetsAt,
              },
              model,
              now,
            );
        }
      }
      // An absent top-level utilization must not erase a valid structured window.
      if (!structured || !Object.hasOwn(unified, type)) record(type, info, model, now);
    },
    read(model: string): QuotaSnapshot {
      const now = Date.now();
      const modelFamily = family(model);
      const selected = windowTypes.flatMap((type) => {
        const value = windows.get(type);
        if (
          !value ||
          value.window.resetAt! <= now ||
          (type.startsWith('seven_day_') && type !== `seven_day_${modelFamily}`)
        )
          return [];
        return [value];
      });
      if (!selected.length)
        return {
          source: 'unknown',
          observedAt: now,
          windows: [],
          detail:
            'No official Claude quota has been observed in an existing request; standalone quota query is unsupported',
        };
      return {
        source: 'official',
        observedAt: Math.max(...selected.map((value) => value.observedAt)),
        pool: selected.some((value) => value.window.name?.startsWith('seven_day_'))
          ? `claude-${modelFamily}`
          : 'claude-common',
        windows: selected.map((value) => ({ ...value.window })),
        detail:
          'Partial official Claude quota observed during an existing request; unreported limits remain unknown',
      };
    },
  };
}
