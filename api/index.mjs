// Vercel serverless entry for FreeLLMAPI. The Express app is built once per function instance:
//  - SQLite lives in /tmp (ephemeral): everything the router needs is re-created at boot from the environment
//    (FREEAPI_CONFIG_JSON = provider keys / models / fallback / admin, FREELLMAPI_FIXED_UNIFIED_KEY = the bearer key clients use),
//  - the long-running schedulers of server/src/index.ts (health checker, cooldown probe, catalog sync, backups) are NOT started here.
process.env.NODE_ENV ||= 'production';
process.env.FREEAPI_DB_PATH ||= '/tmp/freeapi.db';
process.env.TRUST_PROXY ||= '1'; // one proxy (Vercel's edge) in front: per-client rate limiting uses the real client IP

let booting;

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

  const config = { ...loadConfig(), serveStaticAssets: false };
  initDb(config.dbPath ?? undefined);
  applyFixedUnifiedKeyFromEnv();
  applyDeclarativeConfigFromEnv();
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
    return app(req, res);
  } catch (err) {
    booting = undefined; // let the next request retry the boot
    console.error('[vercel] boot failed:', err && err.message ? err.message : err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'router failed to start; see function logs', type: 'server_error' } }));
  }
}
