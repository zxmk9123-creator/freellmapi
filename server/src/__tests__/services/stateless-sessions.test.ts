import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { createUser, createSession, validateSession, updatePassword } from '../../services/auth.js';

// Serverless deployments (api/index.mjs) sign session tokens instead of storing them: another function instance has a different database.
describe('stateless dashboard sessions (FREELLMAPI_STATELESS_SESSIONS=1)', () => {
  const KEY = 'ab'.repeat(32);
  let userId = 0;
  const saved = { flag: process.env.FREELLMAPI_STATELESS_SESSIONS, key: process.env.ENCRYPTION_KEY };
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
    initDb(':memory:');
    userId = createUser('owner@example.test', 'correct horse battery').userId;
  });
  afterAll(() => {
    if (saved.flag === undefined) delete process.env.FREELLMAPI_STATELESS_SESSIONS; else process.env.FREELLMAPI_STATELESS_SESSIONS = saved.flag;
    if (saved.key === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = saved.key;
  });
  beforeEach(() => { process.env.FREELLMAPI_STATELESS_SESSIONS = '1'; process.env.ENCRYPTION_KEY = KEY; });

  it('mints a signed token that is not stored, and any instance with the same user row accepts it', () => {
    const token = createSession(userId);
    expect(token.startsWith('s1.')).toBe(true);
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
    expect(validateSession(token)).toEqual({ userId, email: 'owner@example.test' });
  });

  it('rejects tampered, truncated and re-signed tokens', () => {
    const token = createSession(userId);
    const parts = token.split('.');
    const forgedId = [...parts.slice(0, 1), '999', ...parts.slice(2)].join('.');
    const forgedExp = [...parts.slice(0, 2), String(Date.now() + 1e12), ...parts.slice(3)].join('.');
    for (const bad of [forgedId, forgedExp, token.slice(0, -2), `${token}x`, 's1.1.1.1.deadbeef', '']) expect(validateSession(bad)).toBeNull();
    process.env.ENCRYPTION_KEY = 'cd'.repeat(32); // a different key signs differently
    expect(validateSession(token)).toBeNull();
  });

  it('expires', () => {
    const token = createSession(userId);
    const real = Date.now;
    try {
      Date.now = () => real() + 8 * 24 * 60 * 60 * 1000;
      expect(validateSession(token)).toBeNull();
    } finally { Date.now = real; }
  });

  it('changing the password invalidates every earlier token', () => {
    const token = createSession(userId);
    expect(validateSession(token)).not.toBeNull();
    expect(updatePassword(userId, 'correct horse battery', 'a brand new password')).toBe(true);
    expect(validateSession(token)).toBeNull();
    expect(validateSession(createSession(userId))).not.toBeNull();
  });

  it('is off unless enabled: without the flag (or a valid key) tokens are the usual stored opaque ones', () => {
    delete process.env.FREELLMAPI_STATELESS_SESSIONS;
    const stored = createSession(userId);
    expect(stored.startsWith('s1.')).toBe(false);
    expect(validateSession(stored)).not.toBeNull();
    process.env.FREELLMAPI_STATELESS_SESSIONS = '1';
    process.env.ENCRYPTION_KEY = 'not-hex';
    expect(createSession(userId).startsWith('s1.')).toBe(false);
    expect(validateSession('s1.1.1.1.00')).toBeNull();
  });
});
