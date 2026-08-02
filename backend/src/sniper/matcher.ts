// AND/OR/NOT evaluation over the shared KeywordPattern leaf matcher.
//
// Leaves delegate to @oct/shared `matchKeywords`, so a leaf's semantics
// (includes / exact / regex) are identical to the Discord + Telegram pipelines.
// Only the boolean composition is new here.

import { matchKeywords } from '@oct/shared';
import type { MatcherNode, NormalizedTweet, SnipeRule } from './types.js';

/** Guardrails: a rule is operator input, and in Phase 3 it is model output. */
export const MATCHER_MAX_DEPTH = 8;
export const MATCHER_MAX_NODES = 64;

export function matchesText(node: MatcherNode, text: string): boolean {
  switch (node.op) {
    case 'leaf':
      return matchKeywords(text, [node.pattern]).length > 0;
    case 'and':
      return node.children.every((c) => matchesText(c, text));
    case 'or':
      return node.children.some((c) => matchesText(c, text));
    case 'not':
      return !matchesText(node.child, text);
  }
}

/** Depth + node-count validation. Call at arm time; reject rather than evaluate a bomb. */
export function validateMatcher(
  node: MatcherNode,
  depth = 1,
): { ok: true } | { ok: false; reason: 'too_deep' | 'too_many_nodes' } {
  let count = 0;
  const overLimit = { hit: false as boolean };

  function walk(n: MatcherNode, d: number): void {
    if (overLimit.hit) return;
    if (d > MATCHER_MAX_DEPTH) {
      overLimit.hit = true;
      return;
    }
    count++;
    if (count > MATCHER_MAX_NODES) {
      overLimit.hit = true;
      return;
    }
    switch (n.op) {
      case 'leaf':
        return;
      case 'and':
      case 'or':
        for (const c of n.children) walk(c, d + 1);
        return;
      case 'not':
        walk(n.child, d + 1);
        return;
    }
  }

  walk(node, depth);
  if (overLimit.hit) {
    return { ok: false, reason: count > MATCHER_MAX_NODES ? 'too_many_nodes' : 'too_deep' };
  }
  return { ok: true };
}

/**
 * Does this tweet arm this rule? Checks handle membership, interaction type, and
 * the matcher tree. Staleness and idempotency are enforced later in the fire path,
 * not here — this is a pure predicate.
 */
export function ruleMatchesTweet(rule: SnipeRule, tweet: NormalizedTweet): boolean {
  if (rule.state !== 'armed') return false;
  if (!rule.handles.includes(tweet.handle.toLowerCase())) return false;
  if (!rule.interactionTypes.includes(tweet.interaction)) return false;
  return matchesText(rule.matcher, tweet.text);
}
