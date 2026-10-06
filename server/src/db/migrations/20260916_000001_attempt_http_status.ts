import type { Db } from '../types.js';

/**
 * Migration: request_attempts.http_status — the upstream HTTP status code
 * that ended one attempt (#provider-health-telemetry-durability).
 *
 * The per-attempt trail already records outcome (a coarse failure class:
 * 'timeout', 'rate_limited', 'upstream_error', ...) and a redacted
 * error_summary string, but no STRUCTURED status code — a provider-health
 * query can't group/filter on it without parsing free text. This nullable
 * column stores err.status (set by providerHttpError, providers/base.ts) at
 * the exact point every surface already funnels through
 * (fallback-loop.ts's shared traceAttempt() helper). NULL for a successful
 * hop, a transport-level failure with no HTTP response (network error,
 * hedge-abort timeout), or any other error with no status to report.
 */
export function up(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === 'http_status')) {
    db.prepare('ALTER TABLE request_attempts ADD COLUMN http_status INTEGER').run();
  }
}

export function down(db: Db): void {
  const columns = db.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[];
  if (columns.some((c) => c.name === 'http_status')) {
    db.prepare('ALTER TABLE request_attempts DROP COLUMN http_status').run();
  }
}
