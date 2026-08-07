// The sniper's composition root — the thing that did not exist before this
// change, and the reason nothing could call executeFire.
//
// It holds exactly two long-lived things: the store (mode-selected) and the
// idempotency ledger. It deliberately does NOT hold an ExecutorRegistry: a live
// registry needs a Slotshark executor, a Slotshark executor needs the user's
// API token in its constructor, and venueCredentials.ts:9-11 forbids holding
// that token past the send. So the registry is built per fire, inside
// fireOrchestrator.ts, and dies with the call frame.

import { IdempotencyLedger } from './idempotency.js';
import { getSniperStore } from './stores/index.js';
import type { SniperStore } from './storeInterface.js';

export interface SniperRuntime {
  store: SniperStore;
  ledger: IdempotencyLedger;
  /** Injected clock (ms) so tests stay deterministic. */
  clock: () => number;
}

/** Content-guard window. Prune runs on a multiple of it; nothing depends on the exact value. */
const PRUNE_INTERVAL_MS = 60_000;

let _runtime: SniperRuntime | null = null;

export function getSniperRuntime(): SniperRuntime {
  if (_runtime) return _runtime;

  // The ledger is in-memory and PER PROCESS, and stays that way in the alpha: a
  // restart forgets trigger claims. That is tolerable here only because every
  // fire is a manual press carrying a fresh uuid, so a forgotten claim cannot
  // cause a double buy. It stops being tolerable the day a tweet feed lands —
  // a restart replay is threat T7 — at which point `sniper_fires`' unique
  // (rule_id, trigger_key, wallet_id, leg_no) is already the durable substrate
  // and only a claims table is missing.
  const ledger = new IdempotencyLedger();

  // `.unref()` so an idle sniper never keeps the process alive. Without it a
  // one-shot CLI or a test run would hang on a timer nobody is waiting for.
  const timer = setInterval(() => ledger.prune(Date.now()), PRUNE_INTERVAL_MS);
  timer.unref();

  _runtime = { store: getSniperStore(), ledger, clock: () => Date.now() };
  return _runtime;
}

/** Test seam. Passing null forces the next getSniperRuntime() to rebuild. */
export function setSniperRuntime(runtime: SniperRuntime | null): void {
  _runtime = runtime;
}
