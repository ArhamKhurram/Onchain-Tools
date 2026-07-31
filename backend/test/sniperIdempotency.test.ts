import { describe, it, expect } from 'vitest';
import { IdempotencyLedger, triggerKey, contentHash } from '../src/sniper/idempotency';
import type { NormalizedTweet } from '../src/sniper/types';

const tw = (over: Partial<NormalizedTweet>): NormalizedTweet => ({
  tweetId: 't1', rootTweetId: null, handle: 'elon', interaction: 'tweet',
  text: 'doge to the moon', createdAt: 0, firstSeenAt: 0, ...over,
});

describe('triggerKey', () => {
  it('prefers the lineage root', () => {
    expect(triggerKey(tw({ tweetId: 't2', rootTweetId: 't1' }))).toBe('t1');
  });
  it('falls back to the observed id when lineage is absent', () => {
    expect(triggerKey(tw({ tweetId: 't2', rootTweetId: null }))).toBe('t2');
  });
});

describe('contentHash', () => {
  it('is stable across whitespace and case', () => {
    expect(contentHash('Doge  TO the   MOON')).toBe(contentHash('doge to the moon'));
  });
});

describe('IdempotencyLedger — the double-fire hazard', () => {
  it('claims a fresh trigger once', () => {
    const l = new IdempotencyLedger();
    expect(l.claim('r1', tw({}), 1000)).toBe(true);
    expect(l.claim('r1', tw({}), 1001)).toBe(false); // same tweet, suppressed
  });

  it('collapses a retweet onto the root it amplifies', () => {
    const l = new IdempotencyLedger();
    // Original tweet T1 fires.
    expect(l.claim('r1', tw({ tweetId: 't1', rootTweetId: null }), 1000)).toBe(true);
    // A retweet T2 whose lineage root is T1 — same trigger, suppressed.
    expect(l.claim('r1', tw({ tweetId: 't2', rootTweetId: 't1', interaction: 'retweet' }), 9000)).toBe(false);
  });

  it('the content guard catches a lineage-unavailable duplicate (lean lane, no root)', () => {
    const l = new IdempotencyLedger();
    // Enriched lane fired on the root T1.
    expect(l.claim('r1', tw({ tweetId: 't1', rootTweetId: null }), 1000)).toBe(true);
    // A retweet arrives on the LEAN lane with no lineage — different tweetId, so the
    // trigger key differs, but identical text within the window is caught.
    expect(l.claim('r1', tw({ tweetId: 't2', rootTweetId: null, interaction: 'retweet' }), 1500)).toBe(false);
  });

  it('allows the same text again after the dedupe window', () => {
    const l = new IdempotencyLedger(1000);
    expect(l.claim('r1', tw({ tweetId: 'a', text: 'gm' }), 0)).toBe(true);
    // Different tweet id (new trigger), same text, but past the window → allowed.
    expect(l.claim('r1', tw({ tweetId: 'b', text: 'gm' }), 2000)).toBe(true);
  });

  it('scopes claims per rule', () => {
    const l = new IdempotencyLedger();
    expect(l.claim('r1', tw({}), 1000)).toBe(true);
    expect(l.claim('r2', tw({}), 1000)).toBe(true); // different rule, independent
  });
});
