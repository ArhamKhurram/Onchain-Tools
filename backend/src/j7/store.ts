// Durable callout log — OCT's system-of-record for j7 callouts.
//
// j7 never backfills: the socket only ever pushes what happens while we are
// connected, so whatever OCT sees live is all OCT will ever have. This persists
// the minimum that makes a callout reconstructable later — its id, coin, caller,
// MC-at-call and time — so a restart or a reconnect gap doesn't erase history.
//
// It is DELIBERATELY a small local JSON log rather than a StorageProvider method:
// the existing pump-callout persistence (pumpfun/calloutStore.ts) is Supabase-only
// and welded to the follower/board model, which is the wrong shape for j7's global
// feed, and threading a new method through StorageProvider + json + supabase would
// blow the diff well past this module. The pattern mirrors utils/contractLog.ts —
// an in-memory array rewritten on each append, capped for bounded file size. It is
// best-effort: every fs call is guarded, so a read-only or missing data dir logs
// and degrades, it never throws into the socket path.
//
// Hosted-mode note: the file lands on the container's ephemeral disk, so hosted
// durability is process-lifetime only. That is acceptable here — nothing backfills
// from this log and the live WS feed is the primary surface — but it is the seam
// to promote to Supabase if durable hosted history is ever needed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { J7CalloutData } from './mappers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OCT_DATA_DIR || process.env.TRENCHCORD_DATA_DIR || join(__dirname, '../../data');
const STORE_PATH = join(DATA_DIR, 'j7-callouts.json');

// Bounded like the contract log: the whole array is rewritten on each append, so
// this caps both file size and write cost. Override via J7_CALLOUT_LOG_MAX.
const MAX_ENTRIES = Number.parseInt(process.env.J7_CALLOUT_LOG_MAX ?? '', 10) || 5000;

/** The minimal system-of-record row — exactly what j7 will never re-serve. */
export interface J7CalloutRecord {
  calloutId: string;
  coinMint: string;
  callerAddress: string;
  /** MC-at-call, USD. */
  calledOutAtMcap: number | null;
  /** The call's own time, epoch ms (j7 `timestamp`). */
  timestamp: number | null;
  /** When OCT recorded it, ISO — OCT is system-of-record, so stamp our own clock. */
  recordedAt: string;
}

class J7CalloutStore {
  private records: J7CalloutRecord[] = [];
  // Mirror of the persisted ids, so `record` is O(1) idempotent and doubles as
  // the callout dedup gate across restarts (a reconnect backlog isn't re-fired).
  private ids = new Set<string>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(STORE_PATH)) return;
      const parsed: unknown = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      if (!Array.isArray(parsed)) return;
      this.records = parsed as J7CalloutRecord[];
      for (const r of this.records) {
        if (r && typeof r.calloutId === 'string') this.ids.add(r.calloutId);
      }
    } catch (err) {
      console.error('[J7Store] Failed to load callout log:', (err as Error)?.message);
      this.records = [];
      this.ids.clear();
    }
  }

  private save(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(STORE_PATH, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch (err) {
      console.error('[J7Store] Failed to save callout log:', (err as Error)?.message);
    }
  }

  /** Has this callout already been recorded (persisted-and-still-retained)? */
  has(calloutId: string): boolean {
    return this.ids.has(calloutId);
  }

  /**
   * Persist a callout once. Returns true when newly recorded, false when it was
   * already present (idempotent) — the caller uses that as the dedup signal, so
   * a batched re-send neither re-persists nor re-fans-out.
   */
  record(data: J7CalloutData): boolean {
    if (this.ids.has(data.calloutId)) return false;
    this.ids.add(data.calloutId);
    this.records.unshift({
      calloutId: data.calloutId,
      coinMint: data.coinMint,
      callerAddress: data.callerAddress,
      calledOutAtMcap: data.marketCapUsd,
      timestamp: data.createdAt,
      recordedAt: new Date().toISOString(),
    });
    if (this.records.length > MAX_ENTRIES) {
      for (const dropped of this.records.splice(MAX_ENTRIES)) {
        this.ids.delete(dropped.calloutId);
      }
    }
    this.save();
    return true;
  }
}

let _store: J7CalloutStore | null = null;

/** Process-wide callout store, constructed (and loaded from disk) on first use. */
export function getJ7CalloutStore(): J7CalloutStore {
  return (_store ??= new J7CalloutStore());
}
