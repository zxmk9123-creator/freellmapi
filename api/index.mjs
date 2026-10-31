// Vercel serverless entry for FreeLLMAPI. The Express app is built once per function instance:
//  - SQLite lives in /tmp (ephemeral): everything the router needs is re-created at boot from the environment
//    (FREEAPI_CONFIG_JSON = provider keys / models / fallback / admin, FREELLMAPI_FIXED_UNIFIED_KEY = the bearer key clients use),
//  - the long-running schedulers of server/src/index.ts (health checker, cooldown probe, catalog sync, backups) are NOT started here.
process.env.NODE_ENV ||= 'production';
process.env.FREEAPI_DB_PATH ||= '/tmp/freeapi.db';
process.env.TRUST_PROXY ||= '1'; // one proxy (Vercel's edge) in front: per-client rate limiting uses the real client IP

import fs from 'node:fs';

let booting;
let dbHandle = null;
let lastBackupAt = 0;
const BACKUP_MIN_GAP_MS = 120_000;

// The router keeps what it LEARNS in SQLite (retired models switched off, rate-limit cooldowns, key health). On Vercel every cold instance starts
// from an empty /tmp, so without a backup it re-discovers the same dead models on every cold start — each hop of an answer then burns the 45 s
// retry budget. FREEAPI_DB_BACKUP_* (target/key/token) is the router's own encrypted backup: restore at boot, upload after requests.
async function flushBackup(force = false) {
  if (!dbHandle || (!force && Date.now() - lastBackupAt < BACKUP_MIN_GAP_MS)) return { skipped: true };
  lastBackupAt = Date.now();
  const { backupDbNow } = await import('../server/dist/lib/db-backup.js');
  return backupDbNow(dbHandle, process.env.FREEAPI_DB_PATH);
}
export { flushBackup };

// Keeps the function alive for background work after the response is sent (what @vercel/functions' waitUntil does); a plain promise elsewhere.
function keepAlive(promise) {
  const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  if (ctx?.waitUntil) ctx.waitUntil(promise);
}

async function boot() {
  const { installLogRedaction } = await import('../server/dist/lib/log-redaction.js');
  installLogRedaction();
  const { loadConfig } = await import('../server/dist/lib/config.js');
  const { initDb } = await import('../server/dist/db/index.js');
  const { applyFixedUnifiedKeyFromEnv } = await import('../server/dist/lib/unified-key-pin.js');
  const { applyDeclarativeConfigFromEnv } = await import('../server/dist/services/declarative-config.js');
  const { restoreProxySettings } = await import('../server/dist/lib/proxy.js');
  const { userCount } = await import('../server/dist/services/auth.js');
  const { generateSetupCode } = await import('../server/dist/lib/setup-code.js');
  const { createApp } = await import('../server/dist/app.js');

  const { restoreDbBackupIfNeeded } = await import('../server/dist/lib/db-backup.js');
  const { applyDeclarativeConfig } = await import('../server/dist/services/declarative-config.js');

  const config = { ...loadConfig(), serveStaticAssets: false };
  try {
    await restoreDbBackupIfNeeded(config.dbPath ?? undefined); // a failed restore must never stop the router: it just starts fresh
  } catch (err) {
    console.warn(`[vercel] database restore skipped: ${err && err.message ? err.message : err}`);
  }
  try {
    dbHandle = initDb(config.dbPath ?? undefined);
  } catch (err) {
    // a restored file that will not open (truncated upload, schema from a far newer build): drop it and start from an empty database
    console.warn(`[vercel] restored database unusable (${err && err.message ? err.message : err}); starting fresh`);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${process.env.FREEAPI_DB_PATH}${suffix}`, { force: true });
    dbHandle = initDb(config.dbPath ?? undefined);
  }
  applyFixedUnifiedKeyFromEnv();
  applyDeclarativeConfigFromEnv();
  // models known to be retired/unavailable are switched off from the first request, before the router would learn it the slow way
  try {
    const overrides = JSON.parse(fs.readFileSync(new URL('../vercel/model-overrides.json', import.meta.url), 'utf8'));
    applyDeclarativeConfig(overrides, 'vercel/model-overrides.json');
  } catch (err) {
    console.warn(`[vercel] model overrides not applied: ${err && err.message ? err.message : err}`);
  }
  if (userCount() === 0) generateSetupCode(); // no admin in the config: a remote caller needs the (log-only) setup code, as on any fresh install
  restoreProxySettings();
  return createApp(config);
}

// Serverless state is per instance and ephemeral, so the dashboard/admin API can neither persist anything nor be safely exposed: only the
// OpenAI/Anthropic-compatible wire surface (/v1, /v1beta) and the unauthenticated liveness probe are reachable. Everything else is a 404.
const PUBLIC_PATHS = [/^\/v1(\/|\?|$)/, /^\/v1beta(\/|\?|$)/, /^\/api\/ping(\?|$)/];

export default async function handler(req, res) {
  if (!PUBLIC_PATHS.some((re) => re.test(req.url || ''))) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: { message: 'not found', type: 'not_found' } }));
  }
  try {
    booting ||= boot();
    const app = await booting;
    if (req.method === 'POST') res.once('finish', () => keepAlive(flushBackup().catch((err) => console.warn(`[vercel] backup failed: ${err && err.message ? err.message : err}`))));
    return app(req, res);
  } catch (err) {
    booting = undefined; // let the next request retry the boot
    console.error('[vercel] boot failed:', err && err.message ? err.message : err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'router failed to start; see function logs', type: 'server_error' } }));
  }
}
