import { describe, it, expect } from 'vitest';
import {
  matchesText,
  validateMatcher,
  ruleMatchesTweet,
  MATCHER_MAX_NODES,
} from '../src/sniper/matcher';
import type { MatcherNode, SnipeRule, NormalizedTweet } from '../src/sniper/types';

const leaf = (pattern: string): MatcherNode => ({
  op: 'leaf',
  pattern: { pattern, matchMode: 'includes' },
});

describe('matchesText — boolean composition', () => {
  it('AND requires all children', () => {
    const m: MatcherNode = { op: 'and', children: [leaf('doge'), leaf('moon')] };
    expect(matchesText(m, 'doge to the moon')).toBe(true);
    expect(matchesText(m, 'doge only')).toBe(false);
  });

  it('OR requires any child', () => {
    const m: MatcherNode = { op: 'or', children: [leaf('doge'), leaf('shib')] };
    expect(matchesText(m, 'i like shib')).toBe(true);
    expect(matchesText(m, 'i like pepe')).toBe(false);
  });

  it('NOT inverts', () => {
    const m: MatcherNode = { op: 'and', children: [leaf('buy'), { op: 'not', child: leaf('scam') }] };
    expect(matchesText(m, 'buy this')).toBe(true);
    expect(matchesText(m, 'buy this scam')).toBe(false);
  });

  it('nests', () => {
    const m: MatcherNode = {
      op: 'or',
      children: [
        { op: 'and', children: [leaf('elon'), leaf('mars')] },
        leaf('tripleT'),
      ],
    };
    expect(matchesText(m, 'elon on mars')).toBe(true);
    expect(matchesText(m, 'buy tripleT now')).toBe(true);
    expect(matchesText(m, 'elon alone')).toBe(false);
  });
});

describe('validateMatcher', () => {
  it('accepts a small tree', () => {
    expect(validateMatcher({ op: 'and', children: [leaf('a'), leaf('b')] })).toEqual({ ok: true });
  });

  it('rejects an over-deep tree', () => {
    let node: MatcherNode = leaf('x');
    for (let i = 0; i < 12; i++) node = { op: 'not', child: node };
    expect(validateMatcher(node)).toEqual({ ok: false, reason: 'too_deep' });
  });

  it('rejects too many nodes', () => {
    const children: MatcherNode[] = [];
    for (let i = 0; i < MATCHER_MAX_NODES + 5; i++) children.push(leaf(`k${i}`));
    expect(validateMatcher({ op: 'or', children })).toEqual({ ok: false, reason: 'too_many_nodes' });
  });
});

describe('ruleMatchesTweet', () => {
  const baseRule: SnipeRule = {
    id: 'r1', userId: 'u1', name: 'test', state: 'armed', chain: 'sol', venue: 'dryrun',
    handles: ['elonmusk'], interactionTypes: ['tweet', 'retweet'],
    matcher: leaf('doge'), phase: 1, mint: 'MINT', entryStyle: 'single', ladderSplit: null,
    sizeUnit: 'SOL', sizeTotal: 1, walletIds: ['w1'], perFireCap: 5, perTriggerCap: 5,
    slippageBps: 500, exec: { kind: 'sol', antimev: true }, maxTweetAgeMs: 10_000,
    fireWindowMs: 30_000, maxAttempts: 3, mcapCeiling: null, autoDisableAfterFire: true, dryRun: false,
  };
  const tweet: NormalizedTweet = {
    tweetId: 't1', rootTweetId: null, handle: 'ElonMusk', interaction: 'tweet',
    text: 'doge to the moon', createdAt: 0, firstSeenAt: 0,
  };

  it('matches on handle (case-insensitive), interaction and text', () => {
    expect(ruleMatchesTweet(baseRule, tweet)).toBe(true);
  });

  it('rejects an unarmed rule', () => {
    expect(ruleMatchesTweet({ ...baseRule, state: 'disabled' }, tweet)).toBe(false);
  });

  it('rejects a non-watched handle', () => {
    expect(ruleMatchesTweet(baseRule, { ...tweet, handle: 'someoneelse' })).toBe(false);
  });

  it('rejects a disallowed interaction type', () => {
    expect(ruleMatchesTweet(baseRule, { ...tweet, interaction: 'reply' })).toBe(false);
  });

  it('rejects non-matching text', () => {
    expect(ruleMatchesTweet(baseRule, { ...tweet, text: 'gm' })).toBe(false);
  });
});
