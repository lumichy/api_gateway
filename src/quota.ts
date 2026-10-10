import type { QuotaSnapshot } from './types.ts';
export function quotaScore(
  snapshot: QuotaSnapshot | undefined,
  now = Date.now(),
  ttl = 60000,
  reservations = 0,
): number | null {
  if (!snapshot || snapshot.source === 'unknown') return null;
  const scores: number[] = [];
  for (const w of snapshot.windows) {
    if (w.resetAt !== null && w.resetAt <= now) continue;
    const remaining =
      w.remaining ??
      (w.usedPercent === null || w.usedPercent === undefined ? null : 100 - w.usedPercent);
    if (remaining === null) continue;
    if (
      (snapshot.reported?.source ?? snapshot.source) !== 'manual' &&
      now - snapshot.observedAt > ttl &&
      !(remaining <= 0 && w.resetAt !== null)
    )
      continue;
    if (remaining <= 0) return 0;
    const available = w.unit === 'requests' ? Math.max(0, remaining - reservations) : remaining;
    const score =
      w.unit === 'percent' || (w.usedPercent !== undefined && w.usedPercent !== null)
        ? (w.usedPercent === undefined || w.usedPercent === null
            ? available
            : 100 - w.usedPercent) / 100
        : w.limit && w.limit > 0
          ? available / w.limit
          : null;
    if (score !== null) scores.push(Math.max(0, Math.min(1, score)));
  }
  return scores.length ? Math.min(...scores) : null;
}
export function nextReset(
  snapshot: QuotaSnapshot | undefined,
  now = Date.now(),
): number | undefined {
  const dates =
    snapshot?.windows
      .filter(
        (w) =>
          (w.remaining === 0 || (w.usedPercent ?? 0) >= 100) &&
          w.resetAt !== null &&
          w.resetAt > now,
      )
      .map((w) => w.resetAt!) ?? [];
  // All exhausted windows must reset before this pool can become eligible again.
  return dates.length ? Math.max(...dates) : undefined;
}
