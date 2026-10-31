// Two-process check of the Vercel entry's state persistence: process 1 boots, changes the database and flushes the encrypted backup; process 2
// starts with NO local database (a cold instance), and must come up with process 1's state and the shipped model overrides applied.
//   node scripts/vercel-backup-smoke.mjs        (after `npm run build -w server`)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';

if (process.argv[2] === 'child') {
  const phase = process.argv[3];
  const { default: handler, flushBackup } = await import('../api/index.mjs');
  const http = await import('node:http');
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ping = await fetch(`http://127.0.0.1:${server.address().port}/api/ping`);
  assert.equal(ping.status, 200);
  const { getSetting, setSetting, getDb } = await import('../server/dist/db/index.js');
  const result = {};
  if (phase === '1') {
    setSetting('smoke_marker', 'phase1');
    result.flush = await flushBackup(true);
  } else {
    result.marker = getSetting('smoke_marker') ?? null;
    const row = getDb().prepare("SELECT enabled FROM models WHERE platform = 'nvidia' AND model_id = 'deepseek-ai/deepseek-v4-pro'").get();
    result.retiredModelEnabled = row ? row.enabled : 'absent';
  }
  console.log(`RESULT ${JSON.stringify(result)}`);
  server.close();
  process.exit(0);
}

const key = crypto.randomBytes(32).toString('hex');
const dbPath = `/tmp/freellmapi-backup-smoke-${process.pid}.db`;
const backup = `/tmp/freellmapi-backup-smoke-${process.pid}.bak`;
const env = {
  ...process.env, NODE_ENV: 'production', ENCRYPTION_KEY: key, FREEAPI_DB_PATH: dbPath, FREEAPI_DB_BACKUP_TARGET: backup,
  FREELLMAPI_FIXED_UNIFIED_KEY: `freellmapi-${crypto.randomBytes(12).toString('hex')}`,
  FREEAPI_CONFIG_JSON: JSON.stringify({ admin: { email: 'owner@example.test', password: 'a-long-enough-password' } }),
};
const run = (phase) => {
  const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'child', phase], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `phase ${phase} failed:\n${r.stdout.slice(-800)}\n${r.stderr.slice(-800)}`);
  return JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
};
try {
  const first = run('1');
  assert.equal(first.flush.ok, true, JSON.stringify(first));
  assert.ok(fs.existsSync(backup) && fs.statSync(backup).size > 1000, 'an encrypted backup was written');
  assert.ok(!fs.readFileSync(backup).includes('phase1'), 'the backup is encrypted, not plain');
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true }); // the instance is gone: a cold start has no local database
  const second = run('2');
  assert.equal(second.marker, 'phase1', 'the cold instance restored the previous instance\'s state');
  assert.equal(second.retiredModelEnabled, 0, 'a model known to be retired is switched off from the first request');
  console.log('OK: state survives a cold start (restore), the backup is encrypted, and retired models are disabled at boot');
} finally {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, backup]) fs.rmSync(f, { force: true });
}
