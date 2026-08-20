/**
 * Parsing + dedupe for the user-identifier lists that rooms keep
 * (`highlightedUsers`, `filteredUsers`) and the global highlight list.
 *
 * The single-add inputs and the bulk-paste box both go through here so the two
 * paths cannot drift: a bulk path that normalizes differently from the single
 * path would produce entries that never match a message.
 *
 * What downstream matching actually does (see `backend/src/config/store.ts`
 * `isUserHighlighted` and `frontend/src/hooks/useClientGateway.ts`):
 *   - a bare numeric entry is compared to the Discord snowflake, exactly;
 *   - an `@handle` entry is compared to the username, case-insensitively.
 * So casing is only ever significant for display, never for matching — which is
 * why dedupe below is case-insensitive while the stored value keeps the casing
 * the user typed.
 */

export type IdentifierKind = 'discordId' | 'telegramHandle' | 'username';

/** Discord snowflakes are 17-19 digits today; stay loose in both directions. */
const DISCORD_ID_RE = /^\d{15,21}$/;
/** `<@123…>` / `<@!123…>` — what you get from copying a Discord mention. */
const MENTION_RE = /^<@!?(\d{15,21})>$/;
/**
 * Telegram handles: letters, digits, underscore, with at least one alphanumeric
 * so a run of punctuation (`@___`) does not read as a handle. Kept looser than
 * Telegram's own 5-32 rule — rejecting a real handle is worse than keeping a fake one.
 */
const TELEGRAM_HANDLE_RE = /^@(?=[A-Za-z0-9_]{2,64}$)[A-Za-z0-9_]*[A-Za-z0-9][A-Za-z0-9_]*$/;
/** A bare Discord/Telegram username without the sigil. */
const USERNAME_RE = /^(?=[A-Za-z0-9._-]{2,64}$)[A-Za-z0-9._-]*[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Normalize one raw entry to the form that gets stored.
 *
 * Deliberately minimal — trim, and unwrap a pasted Discord mention to the bare
 * snowflake it contains. It does NOT change case and does NOT add or remove a
 * leading `@`: `@alice` (matches a username) and `alice` mean different things
 * to the backend matcher, so coercing between them would silently retarget an
 * entry.
 */
export function normalizeUserIdentifier(raw: string): string {
  const trimmed = raw.trim();
  const mention = MENTION_RE.exec(trimmed);
  return mention ? mention[1] : trimmed;
}

/** Classify a normalized entry, or `null` if it cannot be an identifier at all. */
export function classifyUserIdentifier(value: string): IdentifierKind | null {
  if (DISCORD_ID_RE.test(value)) return 'discordId';
  if (TELEGRAM_HANDLE_RE.test(value)) return 'telegramHandle';
  if (USERNAME_RE.test(value)) return 'username';
  return null;
}

/**
 * The key two entries must share to count as the same person.
 *
 * Case-insensitive, because every matcher downstream lowercases. The leading
 * `@` is part of the key: see the note on `normalizeUserIdentifier`.
 */
export function identifierDedupeKey(value: string): string {
  return value.toLowerCase();
}

export interface ParsedIdentifiers {
  /** New, valid, deduped entries in the order they were pasted. */
  added: string[];
  /** Entries already on the list, or repeated inside the paste itself. */
  duplicates: string[];
  /** Entries that cannot be a user ID or handle at all (spaces, symbols, too long). */
  invalid: string[];
}

/**
 * Split a pasted blob on newlines and commas, normalize each entry, drop blanks,
 * and partition into added / duplicates / invalid against `existing`.
 *
 * Nothing is written here — the caller decides what to do with `added`.
 */
export function parseUserIdentifiers(input: string, existing: readonly string[] = []): ParsedIdentifiers {
  const seen = new Set(existing.map(identifierDedupeKey));
  const added: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];

  // Newlines and commas are the documented separators; semicolons and tabs come
  // along free (neither is legal inside an identifier) so a paste out of a
  // spreadsheet row or a `;`-joined list works too.
  for (const rawEntry of input.split(/[\n\r,;\t]+/)) {
    const value = normalizeUserIdentifier(rawEntry);
    if (!value) continue;

    if (classifyUserIdentifier(value) === null) {
      invalid.push(value);
      continue;
    }

    const key = identifierDedupeKey(value);
    if (seen.has(key)) {
      duplicates.push(value);
      continue;
    }
    seen.add(key);
    added.push(value);
  }

  return { added, duplicates, invalid };
}

/**
 * Append `incoming` to `existing`, skipping anything already present.
 *
 * Used by both the single-add and bulk-add callbacks so the write itself is
 * dedupe-safe even if the parse ran against a stale snapshot of the list.
 */
export function appendUserIdentifiers(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(existing.map(identifierDedupeKey));
  const next = [...existing];
  for (const value of incoming) {
    const key = identifierDedupeKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(value);
  }
  return next;
}

/** One-line summary of a bulk paste, e.g. "Added 37 · 3 already tracked · 2 skipped". */
export function summarizeParse(result: ParsedIdentifiers): string {
  const parts = [`Added ${result.added.length}`];
  if (result.duplicates.length > 0) parts.push(`${result.duplicates.length} already tracked`);
  if (result.invalid.length > 0) parts.push(`${result.invalid.length} skipped`);
  return parts.join(' · ');
}
