// Keyword matching — shared by the backend ingestion pipeline and the browser
// Discord gateway. Moved verbatim from the previously-duplicated
// backend/src/utils/keywordMatcher.ts and frontend/src/discord/keywordMatch.ts,
// which were byte-identical.

import type { KeywordMatchMode, KeywordPattern } from './types.js';

// Failed compiles are cached as null so a bad pattern isn't re-compiled (and
// re-thrown) on every message. Patterns come from user config, so the caches
// stay small and stable.
const regexCache = new Map<string, RegExp | null>();

function getCompiledRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let re: RegExp | null;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = null;
  }
  regexCache.set(pattern, re);
  return re;
}

// Exact mode wraps the escaped pattern in word boundaries. Cache by the RAW
// pattern so the escape + concat work happens once per pattern instead of once
// per message per pattern.
const exactRegexCache = new Map<string, RegExp | null>();

function getExactRegex(pattern: string): RegExp | null {
  const cached = exactRegexCache.get(pattern);
  if (cached !== undefined) return cached;
  let re: RegExp | null;
  try {
    re = new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  } catch {
    re = null;
  }
  exactRegexCache.set(pattern, re);
  return re;
}

// Includes mode compares lowercase-to-lowercase; cache the lowered pattern.
const lowerPatternCache = new Map<string, string>();

function getLowerPattern(pattern: string): string {
  const cached = lowerPatternCache.get(pattern);
  if (cached !== undefined) return cached;
  const lower = pattern.toLowerCase();
  lowerPatternCache.set(pattern, lower);
  return lower;
}

function resolveMode(kw: KeywordPattern): KeywordMatchMode {
  if (kw.matchMode) return kw.matchMode;
  return kw.isRegex ? 'regex' : 'includes';
}

export function matchKeywords(content: string, patterns: KeywordPattern[]): string[] {
  if (!content || patterns.length === 0) return [];

  const matched: string[] = [];
  // Lowering the whole message is the priciest step here — do it only if an
  // includes-mode pattern actually needs it.
  let lowerContent: string | null = null;

  for (const kw of patterns) {
    if (!kw.pattern) continue;
    const label = kw.label || kw.pattern;
    const mode = resolveMode(kw);

    switch (mode) {
      case 'regex': {
        const re = getCompiledRegex(kw.pattern);
        if (re?.test(content)) matched.push(label);
        break;
      }
      case 'exact': {
        const re = getExactRegex(kw.pattern);
        if (re?.test(content)) matched.push(label);
        break;
      }
      case 'includes':
      default: {
        if (lowerContent === null) lowerContent = content.toLowerCase();
        if (lowerContent.includes(getLowerPattern(kw.pattern))) matched.push(label);
        break;
      }
    }
  }

  return matched;
}
