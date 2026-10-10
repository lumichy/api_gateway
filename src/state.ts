import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { QuotaSnapshot } from './types.ts';
export type Budget = { requests: number; tokens: number; credits?: number };
export class State {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS quota_pools (provider TEXT, pool TEXT, snapshot TEXT NOT NULL, requests REAL DEFAULT 0, tokens REAL DEFAULT 0, credits REAL DEFAULT 0, PRIMARY KEY(provider,pool));' +
        'CREATE TABLE IF NOT EXISTS model_pools (provider TEXT, model TEXT, pool TEXT, PRIMARY KEY(provider,model));' +
        'CREATE TABLE IF NOT EXISTS pool_blocks (provider TEXT, pool TEXT, kind TEXT, until_at REAL, PRIMARY KEY(provider,pool));' +
        'CREATE TABLE IF NOT EXISTS pool_leases (id TEXT PRIMARY KEY, provider TEXT, pool TEXT, model TEXT, expires_at REAL, requests REAL, tokens REAL, credits REAL);',
    );
    this.sweep();
  }
  close() {
    this.db.close();
  }
  sweep(now = Date.now()) {
    this.db.prepare('DELETE FROM pool_leases WHERE expires_at<=?').run(now);
  }
  pool(provider: string, model: string): string {
    return (
      (
        this.db
          .prepare('SELECT pool FROM model_pools WHERE provider=? AND model=?')
          .get(provider, model) as any
      )?.pool ?? model
    );
  }
  saveQuota(provider: string, model: string, q: QuotaSnapshot): boolean {
    const current = this.getQuota(provider, model);
    if (q.source !== 'manual' && (current?.reported?.source ?? current?.source) === 'manual')
      return false;
    if (q.source === 'unknown' && current) return false;
    const pool = q.pool ?? model;
    const prev = this.db
      .prepare('SELECT snapshot FROM quota_pools WHERE provider=? AND pool=?')
      .get(provider, pool) as any;
    const previous = prev ? (JSON.parse(prev.snapshot) as QuotaSnapshot) : undefined;
    this.db.prepare('INSERT OR REPLACE INTO model_pools VALUES(?,?,?)').run(provider, model, pool);
    // A newly discovered sibling model must inherit, not replace, an operator's pool override.
    if (
      previous &&
      q.source !== 'manual' &&
      (previous.reported?.source ?? previous.source) === 'manual'
    )
      return false;
    // A new official observation already includes consumed upstream allowance.
    if (
      previous &&
      q.source === 'official' &&
      (q.observedAt < previous.observedAt ||
        (q.observedAt === previous.observedAt &&
          JSON.stringify(q.windows) === JSON.stringify(previous.windows)))
    )
      return false;
    this.db
      .prepare(
        'INSERT OR REPLACE INTO quota_pools(provider,pool,snapshot,requests,tokens,credits) VALUES(?,?,?,0,0,0)',
      )
      .run(provider, pool, JSON.stringify({ ...q, pool }));
    return true;
  }
  getQuota(provider: string, model: string): QuotaSnapshot | undefined {
    const row = this.db
      .prepare('SELECT * FROM quota_pools WHERE provider=? AND pool=?')
      .get(provider, this.pool(provider, model)) as any;
    if (!row) return;
    const reported = JSON.parse(row.snapshot) as QuotaSnapshot;
    if (!row.requests && !row.tokens && !row.credits) return reported;
    const windows = reported.windows.map((w) => {
      const amount =
        w.unit === 'requests'
          ? row.requests
          : w.unit === 'tokens'
            ? row.tokens
            : w.unit === 'credits'
              ? row.credits
              : 0;
      return { ...w, remaining: w.remaining === null ? null : Math.max(0, w.remaining - amount) };
    });
    return {
      ...reported,
      source: reported.source === 'unknown' ? 'unknown' : 'estimated',
      windows,
      reported,
    };
  }
  block(provider: string, model: string, kind: string, until: number) {
    this.db
      .prepare('INSERT OR REPLACE INTO pool_blocks VALUES(?,?,?,?)')
      .run(provider, model === '*' ? '*' : this.pool(provider, model), kind, until);
  }
  getBlock(provider: string, model: string) {
    return this.db
      .prepare(
        'SELECT kind,until_at AS until FROM pool_blocks WHERE provider=? AND (pool=? OR pool=?) AND until_at>? ORDER BY until_at DESC LIMIT 1',
      )
      .get(provider, this.pool(provider, model), '*', Date.now()) as
      { kind: string; until: number } | undefined;
  }
  clearBlock(provider: string, model: string) {
    this.db
      .prepare('DELETE FROM pool_blocks WHERE provider=? AND (pool=? OR pool=?)')
      .run(provider, this.pool(provider, model), '*');
  }
  reset(provider: string, model: string) {
    const pool = this.pool(provider, model);
    this.clearBlock(provider, model);
    this.db.prepare('DELETE FROM quota_pools WHERE provider=? AND pool=?').run(provider, pool);
  }
  count(provider: string, model?: string): number {
    return Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM pool_leases WHERE provider=? AND expires_at>?' +
              (model === undefined ? '' : ' AND pool=?'),
          )
          .get(
            ...(model === undefined
              ? [provider, Date.now()]
              : [provider, Date.now(), this.pool(provider, model)]),
          ) as any
      ).n,
    );
  }
  reserve(
    provider: string,
    model: string,
    max: number,
    expires: number,
    cost: Budget = { requests: 1, tokens: 4096 },
    ttl = 60000,
  ): string | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.sweep();
      const pool = this.pool(provider, model);
      const count = this.count(provider, model);
      const recovery = this.db
        .prepare('SELECT 1 FROM pool_blocks WHERE provider=? AND (pool=? OR pool=?)')
        .get(provider, pool, '*');
      if (
        this.count(provider) >= max ||
        (recovery && count > 0) ||
        this.getBlock(provider, model)
      ) {
        this.db.exec('COMMIT');
        return;
      }
      const reserved = this.db
        .prepare(
          'SELECT COALESCE(SUM(requests),0) AS requests,COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(credits),0) AS credits FROM pool_leases WHERE provider=? AND pool=? AND expires_at>?',
        )
        .get(provider, pool, Date.now()) as any;
      const quota = this.getQuota(provider, model);
      const fresh =
        quota &&
        ((quota.reported?.source ?? quota.source) === 'manual' ||
          Date.now() - quota.observedAt <= ttl);
      for (const w of quota?.windows ?? []) {
        if (!fresh && !(w.remaining === 0 && w.resetAt !== null && w.resetAt > Date.now()))
          continue;
        if (
          w.remaining === null ||
          (w.resetAt !== null && w.resetAt <= Date.now()) ||
          w.unit === 'percent'
        )
          continue;
        const amount =
          w.unit === 'requests' ? cost.requests : w.unit === 'tokens' ? cost.tokens : cost.credits;
        if (amount === undefined || w.remaining - reserved[w.unit] < amount) {
          this.db.exec('COMMIT');
          return;
        }
      }
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO pool_leases VALUES(?,?,?,?,?,?,?,?)')
        .run(id, provider, pool, model, expires, cost.requests, cost.tokens, cost.credits ?? 0);
      this.db.exec('COMMIT');
      return id;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  release(id: string) {
    this.db.prepare('DELETE FROM pool_leases WHERE id=?').run(id);
  }
  consume(
    provider: string,
    model: string,
    usage?: { total_tokens: number },
    cost: Budget = { requests: 1, tokens: 4096 },
  ) {
    this.db
      .prepare(
        'UPDATE quota_pools SET requests=requests+?,tokens=tokens+?,credits=credits+? WHERE provider=? AND pool=?',
      )
      .run(
        cost.requests,
        usage && Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0
          ? usage.total_tokens
          : cost.tokens,
        cost.credits ?? 0,
        provider,
        this.pool(provider, model),
      );
  }
  status() {
    this.sweep();
    return {
      quotas: this.db
        .prepare('SELECT provider,model FROM model_pools')
        .all()
        .map((r: any) => ({
          provider: r.provider,
          model: r.model,
          ...this.getQuota(r.provider, r.model),
        })),
      blocks: this.db.prepare('SELECT provider,pool,kind,until_at AS until FROM pool_blocks').all(),
      leases: this.db
        .prepare(
          'SELECT provider,model,pool,expires_at AS expiresAt,requests,tokens,credits FROM pool_leases',
        )
        .all(),
    };
  }
}
