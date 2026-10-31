// End-to-end check of the DASHBOARD on the serverless entry, in a real browser: static files served like Vercel does (client/dist first, SPA
// fallback to index.html), /api and /v1 handled by api/index.mjs. Needs `npm run build -w server -w client` and Playwright.
//   node scripts/vercel-dashboard-smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

process.env.NODE_ENV = 'production';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.FREEAPI_DB_PATH = `/tmp/freellmapi-dash-smoke-${process.pid}.db`;
process.env.FREELLMAPI_FIXED_UNIFIED_KEY = `freellmapi-${crypto.randomBytes(12).toString('hex')}`;
const PASSWORD = 'a-long-enough-password';
process.env.FREEAPI_CONFIG_JSON = JSON.stringify({
  admin: { email: 'owner@example.test', password: PASSWORD },
  keys: [{ platform: 'groq', key: 'gsk_smoke_test_key_not_real', label: 'smoke-groq' }],
});

const { default: handler } = await import('../api/index.mjs');
const dist = path.resolve('client/dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (/^\/(api|v1|v1beta)(\/|$)/.test(p)) return handler(req, res);
  const file = path.join(dist, p === '/' ? 'index.html' : p);
  const target = file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(dist, 'index.html'); // SPA fallback
  res.setHeader('content-type', mime[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const apiStatuses = [];
  const consoleErrors = [];
  page.on('response', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) apiStatuses.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  // unauthenticated: the app shows a login form, not data
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  await emailInput.waitFor({ timeout: 60000 });
  assert.ok(await page.locator('input[type="password"]').first().isVisible(), 'a login form is shown');
  assert.equal((await fetch(`${base}/api/keys`)).status, 401, 'the key list needs a login');
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);

  await emailInput.fill('owner@example.test');
  await page.locator('input[type="password"]').first().fill('wrong-password-here');
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(1500);
  assert.ok(await emailInput.isVisible(), 'a wrong password keeps the login form');

  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 60000 });

  // gated routes now answer for this browser's session (a signed token any function instance can verify)
  const token = await page.evaluate(() => { for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) { const v = store.getItem(store.key(i)); if (v && v.startsWith('s1.')) return v; } return null; });
  assert.ok(token, 'the dashboard holds a signed session token');
  const keys = await fetch(`${base}/api/keys`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(keys.status, 200);
  const list = await keys.json();
  assert.ok(JSON.stringify(list).includes('smoke-groq'), 'the provider key from FREEAPI_CONFIG_JSON is listed');
  assert.ok(!JSON.stringify(list).includes('gsk_smoke_test_key_not_real'), 'the key itself is never returned in clear');

  await page.goto(`${base}/keys`, { waitUntil: 'domcontentloaded' }); // a deep link survives a reload (SPA fallback + session)
  await page.waitForFunction(() => document.body.innerText.includes('smoke-groq') || document.body.innerText.toLowerCase().includes('groq'), null, { timeout: 60000 });

  const failed = apiStatuses.filter((s) => / (5\d\d)$/.test(s));
  assert.deepEqual(failed, [], `no server errors while browsing: ${failed.join(', ')}`);
  assert.deepEqual(consoleErrors, [], `no page errors: ${consoleErrors.join(' | ')}`);
  console.log(`OK: login form, wrong password rejected, login works, gated API answers, keys page renders after a reload (${apiStatuses.length} API calls, 0 server errors)`);
} finally {
  await browser.close(); server.close();
  for (const f of ['', '-wal', '-shm']) fs.rmSync(`${process.env.FREEAPI_DB_PATH}${f}`, { force: true });
  process.exit(process.exitCode ?? 0);
}
