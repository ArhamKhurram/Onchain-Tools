// Threshold→emoji markers for the Radar's × column.
//
// A live tester asked for "a fire emoji for coins that pass 5x"; the operator
// widened it to arbitrary user-defined rules with 3x 🧊 / 5x 🔥 as the shipped
// default. Everything here is pure so both ends can share one definition: the
// backend sanitises what a client sends before it reaches the config blob, and
// the console resolves a row's marker at render time.
//
// The one rule that matters: **highest matching threshold wins.** A row at 6x
// shows the 5x marker only — it does not accumulate every emoji it passed. A
// multiple is a single position on a scale, not a set of earned badges, and a
// row that stacked 🧊🔥 would read as two separate facts about one number.
//
// Note what the × actually is on the Radar: live market cap ÷ market cap at the
// first call. It is an unrealised, still-moving quote, not a return anyone
// booked, and it falls as well as rises. The marker is a scanning aid for
// "this one moved", nothing more — see the column tooltip, which says so.

import type { RadarMultipleEmojiRule } from './types.js';

export type { RadarMultipleEmojiRule };

/** Shipped default: ice cube at 3x, fire at 5x. */
export const DEFAULT_RADAR_MULTIPLE_EMOJI_RULES: readonly RadarMultipleEmojiRule[] = [
  { threshold: 3, emoji: '\u{1F9CA}' }, // 🧊
  { threshold: 5, emoji: '\u{1F525}' }, // 🔥
];

/** Bounds: enough for any real ladder, small enough that the config blob and the
 *  table cell both stay sane. */
export const MAX_RADAR_EMOJI_RULES = 12;
export const MAX_RADAR_EMOJI_LENGTH = 8;
const MIN_RADAR_EMOJI_THRESHOLD = 1.1;
const MAX_RADAR_EMOJI_THRESHOLD = 100_000;

/**
 * Strip a pasted emoji down to something safe to render.
 *
 * The value round-trips through the config blob and lands in a table cell, so
 * it is treated as hostile input even though React already escapes it: markup
 * characters, quotes, backslashes and every C0/C1 control (including the
 * bidirectional-override characters that can visually reorder a row) are
 * removed outright rather than encoded. Whitespace collapses away — a marker is
 * one glyph, not a phrase — and the result is capped at
 * {@link MAX_RADAR_EMOJI_LENGTH} UTF-16 units, which fits a ZWJ family sequence
 * or a flag but not a paragraph.
 *
 * Returns '' when nothing renderable survives; callers drop those rules.
 */
export function sanitizeRadarEmoji(input: unknown): string {
  if (typeof input !== 'string') return '';
  let out = '';
  // Iterate by code point so a cap never splits a surrogate pair into a lone
  // half (which renders as a replacement box).
  for (const ch of input.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 controls + DEL + C1 controls.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    // Whitespace of any kind, including the exotic spaces.
    if (/\s/u.test(ch)) continue;
    // Markup / quoting / escaping characters. React escapes these, but an
    // emoji has no business containing one, so drop rather than trust.
    if ('<>&"\'`\\{}'.includes(ch)) continue;
    // Bidi controls and other invisible formatting (Cf), except the two that
    // legitimately build emoji: ZWJ (200D) and the variation selectors.
    if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) {
      out += ch;
      continue;
    }
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
        (code >= 0x2060 && code <= 0x206f) || code === 0xfeff) continue;
    if (out.length + ch.length > MAX_RADAR_EMOJI_LENGTH) break;
    out += ch;
  }
  return out;
}

/**
 * Validate and order a rule list arriving from a client or from stored config.
 *
 * Rules come back sorted ascending by threshold, deduped on threshold (a later
 * entry replaces an earlier one at the same level), with unusable entries
 * dropped rather than coerced. Sorting here is what lets
 * {@link radarEmojiForMultiple} walk the list once and lets the settings UI
 * render the ladder in the order it applies.
 */
export function sanitizeRadarEmojiRules(input: unknown): RadarMultipleEmojiRule[] {
  if (!Array.isArray(input)) return [];
  const byThreshold = new Map<number, RadarMultipleEmojiRule>();

  for (const raw of input.slice(0, MAX_RADAR_EMOJI_RULES * 4)) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;

    const threshold = Number(candidate.threshold);
    if (!Number.isFinite(threshold)) continue;
    if (threshold < MIN_RADAR_EMOJI_THRESHOLD || threshold > MAX_RADAR_EMOJI_THRESHOLD) continue;
    // One decimal is the table's own precision; storing 3.14159x would mark a
    // row the displayed number doesn't justify.
    const rounded = Math.round(threshold * 10) / 10;

    const emoji = sanitizeRadarEmoji(candidate.emoji);
    if (!emoji) continue;

    byThreshold.set(rounded, { threshold: rounded, emoji });
  }

  return [...byThreshold.values()]
    .sort((a, b) => a.threshold - b.threshold)
    .slice(0, MAX_RADAR_EMOJI_RULES);
}

/**
 * Resolve stored config into the rule list to render with.
 *
 * `undefined` (never configured, or an older backend) falls back to the
 * defaults; an explicit empty array means the user turned markers off and is
 * honoured as-is.
 */
export function resolveRadarEmojiRules(
  configured: readonly RadarMultipleEmojiRule[] | undefined | null,
): RadarMultipleEmojiRule[] {
  if (configured == null) return DEFAULT_RADAR_MULTIPLE_EMOJI_RULES.map((r) => ({ ...r }));
  return sanitizeRadarEmojiRules(configured);
}

/**
 * The single marker for a multiple: the emoji of the highest threshold the
 * multiple reaches, or `undefined` below the lowest threshold.
 *
 * Highest-match-wins is enforced by scanning from the top of the ascending list
 * downward and returning on the first hit, so exactly one rule can ever fire.
 */
export function radarEmojiForMultiple(
  multiple: number | null | undefined,
  rules: readonly RadarMultipleEmojiRule[],
): string | undefined {
  if (multiple == null || !Number.isFinite(multiple)) return undefined;
  const ordered = [...rules].sort((a, b) => a.threshold - b.threshold);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const rule = ordered[i];
    if (multiple >= rule.threshold) return rule.emoji;
  }
  return undefined;
}
