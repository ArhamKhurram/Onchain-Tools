// Store selection. Memoized and settable, deliberately the same shape as
// storage/index.ts:7-23 so it reads as the same idea, and selected by the SAME
// `isHostedMode()` — there must never be two answers to "which mode is this".

import { isHostedMode } from '../../storage/index.js';
import type { SniperStore } from '../storeInterface.js';
import { JsonSniperStore } from './jsonSniperStore.js';
import { SupabaseSniperStore } from './supabaseSniperStore.js';

let _store: SniperStore | null = null;

export function getSniperStore(): SniperStore {
  if (_store) return _store;
  _store = isHostedMode() ? new SupabaseSniperStore() : new JsonSniperStore();
  return _store;
}

/** Test seam. Also how the desktop shell could inject a different backing later. */
export function setSniperStore(store: SniperStore | null): void {
  _store = store;
}

export { JsonSniperStore, resetLocalSniperCache } from './jsonSniperStore.js';
export { SupabaseSniperStore } from './supabaseSniperStore.js';
