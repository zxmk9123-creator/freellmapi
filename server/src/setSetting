import { setSetting } from '../db/index.js';

export function applyFixedUnifiedKeyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const fixedUnifiedKey = env.FREELLMAPI_FIXED_UNIFIED_KEY?.trim();
  if (!fixedUnifiedKey) return false;
  setSetting('unified_api_key', fixedUnifiedKey);
  console.log('[config] unified API key pinned from FREELLMAPI_FIXED_UNIFIED_KEY');
  return true;
}
