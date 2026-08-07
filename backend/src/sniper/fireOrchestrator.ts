// fireRuleNow — the single bridge between an HTTP request and executeFire.
//
// It resolves the tension the recon flagged as the biggest un-designed seam:
// `SlotsharkExecutor` takes `apiToken` in its CONSTRUCTOR, while
// venueCredentials.ts:9-11 forbids holding that token past the send. A registry
// of long-lived executors and a short-lived secret cannot both be true.
//
// THE RESOLUTION: in the alpha the ExecutorRegistry is PER FIRE, not a
// singleton. A fresh registry is built here, the Slotshark executor is
// registered onto it from a freshly-read secret, and both die with this call
// frame. The registry is two Map writes; the secret is not something to keep.
//
// `secret` is never assigned to module scope, never interpolated into a log
// line, and never returned. The only place it goes is the SlotsharkExecutor
// constructor, from which it reaches exactly one place: an `Authorization:
// Bearer` header (executors/slotshark.ts:69).

import { executeFire, type FireResult } from './executeFire.js';
import { DryRunExecutor } from './executors/dryRun.js';
import { ExecutorRegistry } from './executors/registry.js';
import { SlotsharkExecutor, narrowRegion } from './executors/slotshark.js';
import { getSniperRuntime } from './runtime.js';
import { getVenueConnection, getVenueSecret } from './venueCredentials.js';
import type { NormalizedTweet, SnipeRule } from './types.js';

export interface FireRuleNowParams {
  userId: string;
  rule: SnipeRule;
  tweet: NormalizedTweet;
  /** Latest pushed market cap, if the caller has one. Never fetched inline. */
  pushedMcap?: (mint: string) => number | undefined;
}

/**
 * Aborts that happen BEFORE executeFire is entered. They are shaped as a
 * FireResult so the route has one response shape to render, but they are
 * distinguishable by having zero legs and one of these reasons.
 */
export type PreflightReason = 'no_credential' | 'venue_unsupported' | 'no_wallet_address';

function abortedBefore(reason: PreflightReason): FireResult {
  return { outcome: 'aborted', reason, legs: [], ruleDisabled: false };
}

export async function fireRuleNow(params: FireRuleNowParams): Promise<FireResult> {
  const { userId, rule, tweet, pushedMcap } = params;
  const { store, ledger, clock } = getSniperRuntime();

  const registry = new ExecutorRegistry(new DryRunExecutor());

  if (!registry.isDryRun(rule)) {
    // Read the secret as late as possible and only when this fire will actually
    // touch a venue. A dry run never reaches this branch, so a dry-run test buy
    // works with no credential connected at all — which is what makes
    // "dry-run first, then live" a real workflow rather than a two-step setup.
    const secret = await getVenueSecret(userId, rule.venue);
    if (!secret) {
      // Return BEFORE constructing anything. `no_credential` is the whole
      // message: no length, no prefix, no hint about what was found.
      return abortedBefore('no_credential');
    }

    if (rule.venue !== 'slotshark') {
      return abortedBefore('venue_unsupported');
    }

    const connection = await getVenueConnection(userId, rule.venue);
    const region = narrowRegion(connection.region);

    // resolveWalletAddress is the mapping SlotsharkConfig always wanted and
    // never had a backing store for. It is built from the user's own wallet
    // rows, once, so the executor cannot reach across tenants even if a rule
    // carried someone else's walletId.
    const wallets = await store.listWallets(userId);
    const addressByWalletId = new Map(wallets.map((w) => [w.walletId, w.address]));
    if (rule.walletIds.some((id) => !addressByWalletId.get(id))) {
      return abortedBefore('no_wallet_address');
    }

    registry.register(
      new SlotsharkExecutor({
        apiToken: secret,
        region,
        resolveWalletAddress: (walletId) => addressByWalletId.get(walletId),
      }),
    );
  }

  // ExecutorRegistry.resolve throws on an unregistered venue or a chain
  // mismatch (registry.ts:50-56), and that throw is uncaught inside executeFire
  // (:99). Catching it here keeps a misconfigured rule a 4xx rather than an
  // unhandled rejection that takes down the request.
  try {
    return await executeFire(rule, tweet, { store, ledger, registry, clock, pushedMcap });
  } catch (err) {
    console.error(`[sniper] fire failed for rule=${rule.id}:`, (err as Error)?.message ?? err);
    return abortedBefore('venue_unsupported');
  }
}
