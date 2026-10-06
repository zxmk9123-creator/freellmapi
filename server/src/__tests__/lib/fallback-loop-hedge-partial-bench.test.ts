import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Regression for the "hedge-aborted route that did NOT own the whole budget
// was never benched" bug: a route reached late in the ladder (so its own
// silent window is under HEDGE_BENCH_MIN_SILENT_FRACTION of the total
// budget) used to be released from recordRetryableFailure() with zero
// penalty — no cooldown, no skip entry — so the exact same route could be
// re-picked on the very next request and stall again, forever, instead of
// failing over promptly (the electronhub/qwen3.8-flash production pattern).
// The fix: that branch now also applies a short, non-escalating
// TRANSIENT_COOLDOWN_MS cooldown (fallback-loop.ts, the `else` of
// `if (ownedWholeBudget)` in the isHedgeAbortError handler), while the
// ownedWholeBudget === true branch keeps its existing full
// recordRetryableFailure() treatment completely unchanged.

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  newFallbackState,
  runFallbackLoop,
  resetModelFailureWindows,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import { newHedgeAbortError } from '../../lib/error-classify.js';
import { isOnCooldown, clearCooldownsForKey, resetKeyLocalityCache, TRANSIENT_COOLDOWN_MS } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

const PLATFORM = 'electronhub';
const MODEL_ID = 'qwen3.8-flash';
let keyA = 0;
let keyB = 0;
let keyC = 0;

function insertKey(label: string): number {
  const { encrypted, iv, authTag } = encrypt(`test-${label}`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(PLATFORM, label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

// A distinct modelDbId per test (see modelDbIdSeq below) — noteModelFailure's
// sliding failure window is keyed by modelDbId and is MODULE-level state that
// outlives one test case; sharing one modelDbId across tests that each
// individually produce several recordRetryableFailure() calls can cross
// MODEL_FAILURE_THRESHOLD cumulatively and spuriously bench an unrelated
// key in a LATER test, regardless of resetModelFailureWindows() in
// beforeEach (which only resets module state, not any already-applied DB
// cooldown row a stale cross-test trip already wrote). Giving each test its
// own modelDbId makes that structurally impossible.
function routeFor(keyId: number, modelDbId: number, modelId = MODEL_ID): RouteResult {
  return {
    provider: {} as any,
    modelId,
    modelDbId,
    apiKey: 'k',
    keyId,
    platform: PLATFORM,
    displayName: modelId,
    rpdLimit: null,
    tpdLimit: null,
  };
}

function hooks(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0,
    route: () => { throw new Error('unused'); },
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => {},
    onRoutingExhausted: () => {},
    onExhausted: () => {},
    ...overrides,
  };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  process.env.NODE_ENV = 'test';
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  keyA = insertKey('key-a');
  keyB = insertKey('key-b');
  keyC = insertKey('key-c');
  resetKeyLocalityCache();
});

beforeEach(() => {
  // clearCooldownsForKey takes only (keyId) — not (platform, keyId).
  clearCooldownsForKey(keyA);
  clearCooldownsForKey(keyB);
  clearCooldownsForKey(keyC);
  // Module-level state (noteModelFailure's sliding failure window) outlives
  // a test case within this file — each test also gets its own modelDbId
  // (see routeFor) so cross-test failure counts can never cumulatively cross
  // MODEL_FAILURE_THRESHOLD and bench an unrelated key; this clears the
  // window too, belt-and-suspenders.
  resetModelFailureWindows();
});

// Stalls until the hedge abort fires, then rejects with the marked error —
// mirrors what a real fetch does when the surface aborts via abortInFlight().
function stalledDispatch(hedgeAbort: AbortController) {
  return async (): Promise<never> =>
    new Promise((_resolve, reject) => {
      hedgeAbort.signal.addEventListener('abort', () => reject(newHedgeAbortError()), { once: true });
    });
}

describe('hedge-abort partial-budget bench (electronhub/qwen3.8-flash repeated-stall fix)', () => {
  it('a late hedge-aborted route (did not own the whole budget) is temporarily skipped on the next request', async () => {
    // Small budget, two SLOW-ish (30ms) fast failures ahead of the stalled
    // attempt, so by the time the stalled route starts it inherits only the
    // scraps of the 100ms budget (~40ms remaining — under the 75% threshold)
    // — the exact "reached late in the ladder" shape from production.
    const hedgeAbort = new AbortController();
    const candidates = [routeFor(keyA, 101), routeFor(keyB, 101), routeFor(keyC, 101)];
    let calls = 0;
    const onExhausted = vi.fn();

    await runFallbackLoop(hooks({
      timeBudgetMs: 100,
      maxRetries: 5,
      abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
      route: () => candidates[calls++] ?? (() => { throw Object.assign(new Error('empty'), { status: 429 }); })(),
      dispatch: async (r) => {
        if (r.keyId === keyA || r.keyId === keyB) {
          await new Promise(res => setTimeout(res, 30));
          throw Object.assign(new Error('fake 429'), { status: 429 });
        }
        // keyC (the "electronhub/qwen3.8-flash" stand-in): stalls until the
        // hedge timer aborts it.
        return stalledDispatch(hedgeAbort)();
      },
      onExhausted,
    }));

    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][1].timedOut).toBe(true);

    // The stalled route must now be on cooldown — "temporarily skipped on
    // the next request" — where before this fix it was released with zero
    // penalty and could stall again immediately.
    expect(isOnCooldown(PLATFORM, MODEL_ID, keyC)).toBe(true);

    // And the cooldown must be the SHORT transient one, not a long/escalated
    // bench invented for this fix — reusing the existing policy exactly.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + TRANSIENT_COOLDOWN_MS + 5_000);
      expect(isOnCooldown(PLATFORM, MODEL_ID, keyC)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a route that owns the whole budget retains the existing full recordRetryableFailure treatment, unchanged', async () => {
    // Two INSTANT fast failures ahead of the stalled attempt: they consume
    // essentially none of the 100ms budget, so the stalled route inherits
    // effectively the whole thing — the ownedWholeBudget === true case,
    // which must keep going through recordRetryableFailure() exactly as
    // before this fix.
    const hedgeAbort = new AbortController();
    const candidates = [routeFor(keyA, 102), routeFor(keyB, 102), routeFor(keyC, 102)];
    let calls = 0;
    const onExhausted = vi.fn();
    const logFailure = vi.fn();

    await runFallbackLoop(hooks({
      timeBudgetMs: 100,
      maxRetries: 5,
      abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
      route: () => candidates[calls++] ?? (() => { throw Object.assign(new Error('empty'), { status: 429 }); })(),
      dispatch: async (r) => {
        if (r.keyId === keyA || r.keyId === keyB) {
          throw Object.assign(new Error('fake 429'), { status: 429 });
        }
        return stalledDispatch(hedgeAbort)();
      },
      onExhausted,
      logFailure,
    }));

    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][1].timedOut).toBe(true);
    // Full bench still applies when the route owns the whole budget: the
    // existing recordRetryableFailure() path runs for ALL THREE attempts
    // (the two fast 429s plus the hedge-aborted one) — unchanged from before
    // this fix.
    expect(logFailure).toHaveBeenCalledTimes(3);
    expect(isOnCooldown(PLATFORM, MODEL_ID, keyC)).toBe(true);
  });

  it('existing fallback behavior is unchanged: a fast non-hedge retryable failure followed by success is unaffected by this fix', async () => {
    const onExhausted = vi.fn();
    const candidates = [routeFor(keyA, 103), routeFor(keyB, 103)];
    let calls = 0;

    await runFallbackLoop(hooks({
      timeBudgetMs: 400,
      maxRetries: 2,
      route: () => candidates[calls++] ?? (() => { throw Object.assign(new Error('empty'), { status: 429 }); })(),
      dispatch: async (r) => {
        if (r.keyId === keyA) throw Object.assign(new Error('fake 429'), { status: 429 });
        return 'done' as const;
      },
      onExhausted,
    }));

    // No hedge abort ever involved — ordinary retryable-failure-then-success
    // path, completely untouched by this fix.
    expect(onExhausted).not.toHaveBeenCalled();
    expect(isOnCooldown(PLATFORM, MODEL_ID, keyA)).toBe(true);
    expect(isOnCooldown(PLATFORM, MODEL_ID, keyB)).toBe(false);
  });
});
