import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';
import { newRequestTrace, runWithRequestTrace } from '../../lib/attempt-trace.js';
import { persistRequestAttempts } from '../../lib/request-log.js';
import { backupDbNow, restoreDbBackupIfNeeded } from '../../lib/db-backup.js';

// Goal: operational telemetry (provider/model/success-failure/http-status/
// latency/fallback-depth — never prompt/response content) must survive a
// Render restart. Render's free-tier filesystem is ephemeral: without the
// existing encrypted backup/restore pump (lib/db-backup.ts, already reused
// here unmodified), EVERY restart wipes the SQLite file — telemetry
// included — because nothing else makes it durable. This proves the
// REUSED mechanism is sufficient: a real telemetry row written through the
// same logRequest()/persistRequestAttempts() functions every live surface
// calls survives backupDbNow() -> (simulated restart: delete the file) ->
// restoreDbBackupIfNeeded() with every required field intact.

const ORIGINAL_BACKUP_PATH = process.env.FREEAPI_DB_BACKUP_PATH;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function restoreEnv() {
  if (ORIGINAL_BACKUP_PATH === undefined) delete process.env.FREEAPI_DB_BACKUP_PATH;
  else process.env.FREEAPI_DB_BACKUP_PATH = ORIGINAL_BACKUP_PATH;
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
}

describe('provider telemetry survives a simulated Render restart', () => {
  afterEach(() => restoreEnv());

  it('a request + its failover attempts, including the new http_status column, survive backup -> file loss -> restore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-telemetry-durability-'));
    const dbPath = path.join(dir, 'freeapi.db');
    const backupPath = path.join(dir, 'backup.bin');
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    process.env.FREEAPI_DB_BACKUP_PATH = backupPath;

    // Real migrated schema (requests / request_attempts / request_hourly /
    // settings), same as production — not a bare CREATE TABLE stand-in.
    const db = initDb(dbPath);

    // One realistic failover ladder: groq 429 (http_status 429) -> cerebras
    // succeeds. Goes through the exact functions every live surface calls.
    const trace = newRequestTrace();
    runWithRequestTrace(trace, () => {
      logRequest('cerebras', 'llama-3.3-70b', 1, 'success', 120, 45, 842, null, 310);
    });
    trace.records.push(
      { ordinal: 0, platform: 'groq', modelId: 'llama-3.3-70b', keyOrdinal: 1, keyLabel: 'main', outcome: 'rate_limited', startOffsetMs: 0, durationMs: 55, errorSummary: 'Groq API error 429: rate limit', httpStatus: 429 },
      { ordinal: 1, platform: 'cerebras', modelId: 'llama-3.3-70b', keyOrdinal: 1, keyLabel: 'main', outcome: 'ok', startOffsetMs: 55, durationMs: 787, errorSummary: null, httpStatus: null },
    );
    persistRequestAttempts(trace);

    const backup = await backupDbNow(db, dbPath);
    expect(backup.ok).toBe(true);
    db.close();

    // Simulate a Render restart on an ephemeral filesystem: the running
    // process's SQLite file is simply gone when the new container starts.
    fs.rmSync(dbPath);
    expect(fs.existsSync(dbPath)).toBe(false);

    const restore = await restoreDbBackupIfNeeded(dbPath);
    expect(restore.restored).toBe(true);

    const restoredDb = initDb(dbPath);
    const requestRow = restoredDb.prepare(
      `SELECT platform, model_id, status, latency_ms, ttfb_ms, created_at FROM requests ORDER BY id DESC LIMIT 1`,
    ).get() as { platform: string; model_id: string; status: string; latency_ms: number; ttfb_ms: number; created_at: string };

    // Required fields: timestamp, final provider, model, success/failure,
    // total latency, first-byte latency.
    expect(requestRow.platform).toBe('cerebras'); // final provider
    expect(requestRow.model_id).toBe('llama-3.3-70b');
    expect(requestRow.status).toBe('success');
    expect(requestRow.latency_ms).toBe(842); // total latency
    expect(requestRow.ttfb_ms).toBe(310); // first-byte latency
    expect(requestRow.created_at).toBeTruthy(); // timestamp

    const attemptRows = restoredDb.prepare(
      `SELECT ordinal, platform, model_id, outcome, http_status, error_summary FROM request_attempts ORDER BY ordinal`,
    ).all() as { ordinal: number; platform: string; model_id: string; outcome: string; http_status: number | null; error_summary: string | null }[];

    // Required fields: fallback depth (2 attempts = depth 2), provider/model
    // per attempt, failure type (outcome), HTTP status, timeout-ness
    // (derivable from outcome).
    expect(attemptRows).toHaveLength(2); // fallback depth
    expect(attemptRows[0]).toMatchObject({ platform: 'groq', model_id: 'llama-3.3-70b', outcome: 'rate_limited', http_status: 429 });
    expect(attemptRows[0].error_summary).toContain('429');
    expect(attemptRows[1]).toMatchObject({ platform: 'cerebras', model_id: 'llama-3.3-70b', outcome: 'ok', http_status: null });

    // Never stores prompt/response content: nothing written above included
    // any, and the schema has no column for it — confirmed by exhaustively
    // listing both tables' columns.
    const requestCols = (restoredDb.prepare(`PRAGMA table_info(requests)`).all() as { name: string }[]).map(c => c.name);
    const attemptCols = (restoredDb.prepare(`PRAGMA table_info(request_attempts)`).all() as { name: string }[]).map(c => c.name);
    for (const col of [...requestCols, ...attemptCols]) {
      expect(col).not.toMatch(/prompt|completion_text|response_body|message_content/i);
    }

    restoredDb.close();
  });
});
