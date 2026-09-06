// Batching: many events, one ping.
//
// A digest of eight detections is one notification. Eight separate messages is
// what flooded a live group and got the bot turned off in production. So digest
// is the DEFAULT delivery mode for every alert class a chat opts into, and
// per-event delivery is the exception that has to be asked for by name (and is
// only offered where upstream volume is bounded — see alertPolicy.ts).
//
// THIS BUFFER IS BOUNDED, NOT A QUEUE. Two things keep it that way, and both
// matter more than completeness:
//
//   • COALESCING. The same address seen five times in one window is ONE line
//     reading "×5", not five lines. On a busy feed the same mint crosses
//     several channels within seconds, and a digest that lists it five times is
//     just the flood with extra steps.
//
//   • A HARD CAP per chat. Past MAX_ENTRIES the entry is counted and dropped,
//     never stored. An unbounded buffer between a loud producer and a paced
//     consumer is a memory leak with a delay on it; the digest says how many it
//     could not fit and that is the honest end of it.
//
// Pure and clock-injected: no timers live here. index.ts owns the interval that
// calls flush, exactly as it owns the poll loop.

import type { TgAlertType } from './alertPolicy.js';

/** Distinct lines one chat's digest will hold before the rest are dropped. */
export const MAX_ENTRIES = 25;

/** Default gap between digests. Env-tunable; see readDigestIntervalMs. */
const DEFAULT_DIGEST_INTERVAL_MS = 600_000; // 10 min

/** Floor and ceiling on the configured interval, so a typo cannot spam or stall. */
const MIN_DIGEST_INTERVAL_MS = 60_000; // 1 min
const MAX_DIGEST_INTERVAL_MS = 6 * 3_600_000; // 6h

/**
 * How often digests are flushed.
 *
 * Clamped rather than trusted: `TG_BOT_DIGEST_INTERVAL_MS=100` would turn the
 * digest back into per-event delivery, which is the bug this whole change is
 * about. The floor makes that unreachable by configuration.
 */
export function readDigestIntervalMs(): number {
  for (const key of ['TG_BOT_DIGEST_INTERVAL_MS', 'OCT_TG_BOT_DIGEST_INTERVAL_MS']) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0) {
      const clamped = Math.min(Math.max(value, MIN_DIGEST_INTERVAL_MS), MAX_DIGEST_INTERVAL_MS);
      if (clamped !== value) {
        console.warn(`[TgBot] ${key}=${value} is out of range; using ${clamped}ms.`);
      }
      return clamped;
    }
    console.warn(`[TgBot] Ignoring invalid ${key}=${JSON.stringify(raw)}.`);
  }
  return DEFAULT_DIGEST_INTERVAL_MS;
}

/** One event, reduced to what a digest line needs. */
export interface DigestEntry {
  type: TgAlertType;
  /**
   * The coalescing key. Two entries sharing one collapse into a single line
   * with a count — normally the contract address, since that is what makes two
   * detections "the same call" rather than two calls.
   */
  key: string;
  /** Rendered Telegram HTML for one line. Already escaped by the caller. */
  line: string;
}

/** One line of a flushed digest. */
export interface DigestLine {
  type: TgAlertType;
  line: string;
  /** How many events collapsed into this line. Always ≥ 1. */
  count: number;
}

export interface PendingDigest {
  chatId: number;
  lines: DigestLine[];
  /** Events refused because the chat was already at MAX_ENTRIES. */
  dropped: number;
  /** Epoch ms of the first event in this batch — the digest's "since". */
  since: number;
}

interface Slot {
  entry: DigestEntry;
  count: number;
  firstAt: number;
}

interface ChatBuffer {
  slots: Map<string, Slot>;
  dropped: number;
  since: number;
}

export class DigestBuffer {
  private chats = new Map<number, ChatBuffer>();

  constructor(private readonly maxEntries: number = MAX_ENTRIES) {}

  /**
   * Buffer one event for one chat.
   *
   * Returns true when it was stored (or coalesced onto an existing line), false
   * when the chat was already full and it was dropped. A repeat of a key
   * already held is ALWAYS accepted — it costs no new line, and refusing it
   * would lose the count on a line we are sending anyway.
   */
  add(chatId: number, entry: DigestEntry, now: number): boolean {
    let buffer = this.chats.get(chatId);
    if (!buffer) {
      buffer = { slots: new Map(), dropped: 0, since: now };
      this.chats.set(chatId, buffer);
    }

    const existing = buffer.slots.get(entry.key);
    if (existing) {
      existing.count += 1;
      return true;
    }

    if (buffer.slots.size >= this.maxEntries) {
      buffer.dropped += 1;
      return false;
    }

    buffer.slots.set(entry.key, { entry, count: 1, firstAt: now });
    return true;
  }

  /** Chats with something to send. Empty when there is nothing to flush. */
  pendingChats(): number[] {
    const ids: number[] = [];
    for (const [chatId, buffer] of this.chats) {
      if (buffer.slots.size > 0) ids.push(chatId);
    }
    return ids;
  }

  /** How many distinct lines one chat currently holds. */
  size(chatId: number): number {
    return this.chats.get(chatId)?.slots.size ?? 0;
  }

  /**
   * Take everything buffered for one chat and clear it.
   *
   * Taking CLEARS regardless of what the caller then does with it: if the
   * ceiling refuses the digest, the batch is dropped rather than carried into
   * the next window. Carrying it would rebuild the unbounded queue this file
   * exists to avoid, and an alert held for two windows is stale anyway.
   */
  take(chatId: number): PendingDigest | null {
    const buffer = this.chats.get(chatId);
    if (!buffer || buffer.slots.size === 0) return null;
    this.chats.delete(chatId);

    const slots = [...buffer.slots.values()].sort((a, b) => a.firstAt - b.firstAt);
    return {
      chatId,
      lines: slots.map((s) => ({ type: s.entry.type, line: s.entry.line, count: s.count })),
      dropped: buffer.dropped,
      since: buffer.since,
    };
  }

  /**
   * Read one chat's buffered lines WITHOUT clearing them.
   *
   * The panel's "Queued" card needs to show what the next digest will contain,
   * and `take` is destructive by design — calling it to render a card would
   * silently swallow the batch, turning a read into a data-losing write. So the
   * two are separate methods, and this one is the only read path.
   */
  peek(chatId: number): { lines: DigestLine[]; dropped: number } {
    const buffer = this.chats.get(chatId);
    if (!buffer) return { lines: [], dropped: 0 };
    const slots = [...buffer.slots.values()].sort((a, b) => a.firstAt - b.firstAt);
    return {
      lines: slots.map((s) => ({ type: s.entry.type, line: s.entry.line, count: s.count })),
      dropped: buffer.dropped,
    };
  }

  /** Discard a chat's batch without rendering it. Used when a chat is muted. */
  discard(chatId: number): void {
    this.chats.delete(chatId);
  }
}
