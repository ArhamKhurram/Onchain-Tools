// Idempotency helpers — the machinery that collapses J7's duplicate delivery
// (two provider lanes, retweets carrying original text) into one fire.
//
// See docs/architecture/sniper-rules.md#idempotency-and-the-double-fire-hazard.

import { createHash } from 'crypto';
import type { NormalizedTweet } from './types.js';

/**
 * The trigger discriminator. Prefer the lineage root so a retweet collapses onto
 * the tweet it amplifies; fall back to the observed id when lineage is absent
 * (J7's lean p_v0 lane). The content guard below is the backstop for the case
 * where the enriched lane never supplies a root.
 */
export function triggerKey(tweet: NormalizedTweet): string {
  return tweet.rootTweetId ?? tweet.tweetId;
}

/** Normalize before hashing so trivial whitespace/case differences do not split a fire. */
export function contentHash(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * Tracks which (ruleId, triggerKey) pairs have fired, plus a time-boxed content
 * guard keyed (ruleId, contentHash). Both are needed: the trigger key catches the
 * common case, the content guard catches the lineage-unavailable duplicate.
 *
 * M1 keeps this in memory. In hosted mode these become durable unique constraints
 * written before any external call (see the fire-path SQL in the docs).
 */
export class IdempotencyLedger {
  private triggers = new Set<string>();
  private content = new Map<string, number>();

  constructor(private dedupeWindowMs = 30_000) {}

  // Composite map keys use a NUL separator, written as an escape so this file
  // stays plain text — a literal NUL byte makes git and grep treat the source as
  // binary. NUL cannot appear in a rule id, tweet id or hex hash, so two distinct
  // pairs can never collide into one key the way a space separator could.
  private tKey(ruleId: string, triggerKey: string): string {
    return `${ruleId}\u0000${triggerKey}`;
  }

  private cKey(ruleId: string, hash: string): string {
    return `${ruleId}\u0000${hash}`;
  }

  /**
   * Atomically claim a trigger. Returns true if this call won the claim (proceed
   * to fire), false if it was already claimed or guarded (suppress). `now` is
   * injected so callers can use a monotonic clock and tests stay deterministic.
   */
  claim(ruleId: string, tweet: NormalizedTweet, now: number): boolean {
    const t = this.tKey(ruleId, triggerKey(tweet));
    if (this.triggers.has(t)) return false;

    const c = this.cKey(ruleId, contentHash(tweet.text));
    const seenAt = this.content.get(c);
    if (seenAt !== undefined && now - seenAt < this.dedupeWindowMs) return false;

    this.triggers.add(t);
    this.content.set(c, now);
    return true;
  }

  /** Drop content-guard entries older than the window. Trigger claims persist (idempotent forever within a run). */
  prune(now: number): void {
    for (const [k, ts] of this.content) {
      if (now - ts >= this.dedupeWindowMs) this.content.delete(k);
    }
  }

  /** Test/inspection helper. */
  hasTrigger(ruleId: string, triggerKey: string): boolean {
    return this.triggers.has(this.tKey(ruleId, triggerKey));
  }
}
