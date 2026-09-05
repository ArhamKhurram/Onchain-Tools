// Bounded in-memory cache of recently-seen Discord messages, keyed by message
// id, used to resolve reply/reference previews without a REST round-trip.
//
// Stateful module: each runtime that imports it (the backend Node process, a
// browser console tab) gets its own module-scoped `cache` — exactly as when
// this lived as separate per-workspace copies. Nothing is shared across
// runtimes; this module only de-duplicates the identical code.
export interface CachedMessage {
  id: string;
  content: string;
  authorName?: string;
  authorUsername?: string;
}

const cache = new Map<string, CachedMessage>();
const MAX = 1500;

export function cacheDiscordMessage(msg: {
  id: string;
  content?: string;
  author?: { username?: string; global_name?: string | null };
}): void {
  const existing = cache.get(msg.id);
  cache.set(msg.id, {
    id: msg.id,
    content: msg.content ?? existing?.content ?? '',
    authorName: msg.author?.global_name ?? msg.author?.username ?? existing?.authorName,
    authorUsername: msg.author?.username ?? existing?.authorUsername,
  });
  while (cache.size > MAX) {
    const key = cache.keys().next().value;
    if (key) cache.delete(key);
  }
}

export function lookupCachedMessage(id: string): CachedMessage | undefined {
  return cache.get(id);
}
