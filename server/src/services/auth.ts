import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

// Dashboard authentication: email + password accounts with opaque session
// tokens. Distinct from the unified API key, which authenticates the /v1 proxy
// for apps — this gates the /api/* admin surface for the human operator (#35).

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATELESS_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // signed tokens cannot be revoked server-side (no row to delete), so they live shorter

export interface SessionUser {
  userId: number;
  email: string;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// FREELLMAPI_STATELESS_SESSIONS=1 (serverless deployments, see api/index.mjs): every function instance has its own throw-away database, so a
// session row written by the instance that handled the login would be unknown to the next one. Instead the token SIGNS (user id, expiry,
// a fingerprint of the current password hash) with a key derived from ENCRYPTION_KEY; any instance holding the same users row verifies it
// without a lookup, and changing the password changes the fingerprint, which invalidates every earlier token.
function statelessSessions(): boolean {
  return process.env.FREELLMAPI_STATELESS_SESSIONS === '1' && /^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY?.trim() ?? '');
}
function sessionMac(data: string): string {
  const key = crypto.createHash('sha256').update(`freellmapi-session:${process.env.ENCRYPTION_KEY!.trim()}`).digest();
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}
function passwordFingerprint(passwordHash: string): string {
  return sha256(`pw:${passwordHash}`).slice(0, 16);
}
function signSession(userId: number, expiresAtMs: number, passwordHash: string): string {
  const data = `s1.${userId}.${expiresAtMs}.${passwordFingerprint(passwordHash)}`;
  return `${data}.${sessionMac(data)}`;
}
function verifySignedSession(token: string): SessionUser | null {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 's1') return null;
  const [, id, exp, fp, mac] = parts;
  const data = `s1.${id}.${exp}.${fp}`;
  const expected = sessionMac(data);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (!(Number(exp) > Date.now())) return null;
  const row = getDb().prepare('SELECT id, email, password_hash FROM users WHERE id = ?').get(Number(id)) as { id: number; email: string; password_hash: string } | undefined;
  if (!row || passwordFingerprint(row.password_hash) !== fp) return null;
  return { userId: row.id, email: row.email };
}

/** The one spelling of an address the DB is keyed on. Exported so callers that
 *  bucket by email (the login throttle in routes/auth.ts) key on exactly what
 *  verifyCredentials will look up — keying on anything else lets a padded
 *  address authenticate against the real row while landing in its own bucket. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return row.c;
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export function createUser(email: string, password: string): SessionUser {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(normalized, hashPassword(password));
  return { userId: Number(result.lastInsertRowid), email: normalized };
}

/** Verify credentials. Returns the user on success, null on failure. */
export function verifyCredentials(email: string, password: string): SessionUser | null {
  const db = getDb();
  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
    .get(normalizeEmail(email)) as { id: number; email: string; password_hash: string } | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { userId: row.id, email: row.email };
}

/** Mint a session and return the raw token (only the hash is persisted). */
export function createSession(userId: number): string {
  if (statelessSessions()) {
    const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string } | undefined;
    if (row) return signSession(userId, Date.now() + STATELESS_SESSION_TTL_MS, row.password_hash);
  }
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export function validateSession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  if (statelessSessions() && token.startsWith('s1.')) return verifySignedSession(token);
  const db = getDb();
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at_ms, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token)) as { user_id: number; expires_at_ms: number; email: string } | undefined;
  if (!row) return null;
  if (row.expires_at_ms < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { userId: row.user_id, email: row.email };
}

export function deleteSession(token: string | undefined | null): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Update the email of the authenticated user after verifying the current password. Throws { code: 'email_taken' } on conflict. */
export function updateEmail(userId: number, currentPassword: string, newEmail: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(userId) as { password_hash: string } | undefined;
  if (!row) return false;
  if (!verifyPassword(currentPassword, row.password_hash)) return false;

  const normalized = normalizeEmail(newEmail);
  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(normalized, userId);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(normalized, userId);
  // Keep sessions alive; the new email will be reflected on the next validateSession call.
  return true;
}

/** Update the password of the authenticated user after verifying the current one. Invalidates all sessions on success. */
export function updatePassword(userId: number, currentPassword: string, newPassword: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(userId) as { password_hash: string } | undefined;
  if (!row) return false;
  if (!verifyPassword(currentPassword, row.password_hash)) return false;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return true;
}

/**
 * Reset the password for the single existing user and invalidate all
 * sessions.
 * Returns false if no user exists.
 */
export function resetUserPassword(newPassword: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number } | undefined;
  if (!row) return false;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), row.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  return true;
}
