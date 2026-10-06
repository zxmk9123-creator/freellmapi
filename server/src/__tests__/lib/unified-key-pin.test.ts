import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settingStore = new Map<string, string>();
vi.mock('../../db/index.js', () => ({
  setSetting: (key: string, value: string) => { settingStore.set(key, value); },
}));

import { applyFixedUnifiedKeyFromEnv } from '../../lib/unified-key-pin.js';

beforeEach(() => {
  settingStore.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyFixedUnifiedKeyFromEnv', () => {
  it('pins the unified key to the env var value when set', () => {
    const applied = applyFixedUnifiedKeyFromEnv({ FREELLMAPI_FIXED_UNIFIED_KEY: 'freellmapi-fixed-abc123' });
    expect(applied).toBe(true);
    expect(settingStore.get('unified_api_key')).toBe('freellmapi-fixed-abc123');
  });

  it('trims surrounding whitespace before storing', () => {
    applyFixedUnifiedKeyFromEnv({ FREELLMAPI_FIXED_UNIFIED_KEY: '  freellmapi-fixed-abc123  ' });
    expect(settingStore.get('unified_api_key')).toBe('freellmapi-fixed-abc123');
  });

  it('does nothing when the env var is unset', () => {
    const applied = applyFixedUnifiedKeyFromEnv({});
    expect(applied).toBe(false);
    expect(settingStore.has('unified_api_key')).toBe(false);
  });

  it('does nothing when the env var is empty/whitespace-only', () => {
    const applied = applyFixedUnifiedKeyFromEnv({ FREELLMAPI_FIXED_UNIFIED_KEY: '   ' });
    expect(applied).toBe(false);
    expect(settingStore.has('unified_api_key')).toBe(false);
  });

  it('logs that the key was pinned from the env var', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    applyFixedUnifiedKeyFromEnv({ FREELLMAPI_FIXED_UNIFIED_KEY: 'freellmapi-fixed-abc123' });
    expect(logSpy.mock.calls.flat().join(' ')).toContain('FREELLMAPI_FIXED_UNIFIED_KEY');
  });
});
