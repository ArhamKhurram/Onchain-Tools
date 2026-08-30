import type { FrontendMessage } from '../types';

const SEP = String.fromCharCode(0);

// Fold cache keyed by the messages-map identity. Zustand runs every
// subscriber's selector on every store write, so the fold must be a cheap
// lookup unless the messages map actually changed reference.
const foldCache = new WeakMap<Record<string, FrontendMessage[]>, string[]>();

function foldAuthors(messages: Record<string, FrontendMessage[]>): string[] {
  const map = new Map<string, string>();
  for (const msgs of Object.values(messages)) {
    for (const msg of msgs) {
      map.set(msg.author.id, msg.author.displayName);
    }
  }
  const out: string[] = [];
  for (const [id, name] of map) out.push(`${id}${SEP}${name}`);
  return out;
}

/**
 * Every (author id, display name) pair present in the message buffers, folded
 * into flat `id<SEP>name` strings so a `useShallow` subscription only fires
 * when a new author appears, one disappears from the buffers, or a display
 * name changes — not on every message from an already-known author.
 */
export function selectAuthorEntries(messages: Record<string, FrontendMessage[]>): string[] {
  let entries = foldCache.get(messages);
  if (!entries) {
    entries = foldAuthors(messages);
    foldCache.set(messages, entries);
  }
  return entries;
}

/** Rebuild the lookup map: config's userNameCache overlaid with the fold. */
export function authorEntriesToMap(
  entries: readonly string[],
  userNameCache: Record<string, string> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (userNameCache) {
    for (const [id, name] of Object.entries(userNameCache)) {
      map.set(id, name);
    }
  }
  for (const entry of entries) {
    const i = entry.indexOf(SEP);
    map.set(entry.slice(0, i), entry.slice(i + 1));
  }
  return map;
}
