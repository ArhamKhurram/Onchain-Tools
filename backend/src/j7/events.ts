// The j7 event router: one socket.io event → the right mapper → a sink. Kept
// free of any socket or WS dependency so it is a pure dispatch function the unit
// tests drive directly (test/j7Events.test.ts) with a fake sink.
//
// Two data events carry signal — `pump_event` and `fomo_event` — each wrapped in
// a `{ type, kind, received_at, data }` envelope. Only one `kind` per event maps
// to a new OCT signal: `callout` for pump, `trade` for fomo. Every other kind
// (pump `reply`; fomo `thesis`/`new_account`) is real j7 traffic we deliberately
// drop for now — logged ONCE so a genuinely new kind shows up as a schema-drift
// line, not once per ~30s delivery batch.

import { mapCallout, mapFomoTrade, type J7CalloutData, type J7FomoTradeData } from './mappers.js';

/** The wrapper every j7 data event arrives in. All fields are best-effort. */
export interface J7Envelope {
  type?: string;
  kind?: string;
  received_at?: string | number;
  data?: unknown;
}

/**
 * Where routed events land. Injected (not imported) so the router stays pure and
 * the wiring — dedup, persistence, WS fan-out — lives in index.ts.
 */
export interface J7EventSink {
  onCallout(data: J7CalloutData): void;
  onFomoTrade(data: J7FomoTradeData): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// One warning per unseen (event × kind) combination. A Set, not a counter: the
// point is to surface a NEW shape once, then stay silent.
const warnedUnknown = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedUnknown.has(key)) return;
  warnedUnknown.add(key);
  console.warn(`[J7] ${message}`);
}

/** Reset the once-per-key warning memo. Test-only seam. */
export function resetUnknownWarnings(): void {
  warnedUnknown.clear();
}

/**
 * Route one raw socket.io event to the sink.
 *
 * `eventName` is the socket.io event name (`pump_event` / `fomo_event`);
 * anything else is logged once and dropped. Within a known event only the
 * mapped kind reaches the sink, and only when the mapper narrows it to a
 * non-null payload — a malformed `data` costs itself, never the socket.
 */
export function routeJ7Event(eventName: string, payload: unknown, sink: J7EventSink): void {
  const env: J7Envelope = isRecord(payload) ? payload : {};
  const kind = typeof env.kind === 'string' ? env.kind : 'unknown';

  if (eventName === 'pump_event') {
    if (kind === 'callout') {
      const mapped = mapCallout(env.data);
      if (mapped) sink.onCallout(mapped);
      return;
    }
    warnOnce(`pump_event:${kind}`, `pump_event kind="${kind}" ignored (only "callout" maps to a call).`);
    return;
  }

  if (eventName === 'fomo_event') {
    if (kind === 'trade') {
      const mapped = mapFomoTrade(env.data);
      if (mapped) sink.onFomoTrade(mapped);
      return;
    }
    warnOnce(`fomo_event:${kind}`, `fomo_event kind="${kind}" ignored (only "trade" maps to a trade).`);
    return;
  }

  warnOnce(`event:${eventName}`, `unknown socket event "${eventName}" ignored (schema drift?).`);
}

/**
 * Fixed-capacity dedup set. Remembers the last N ids in insertion order and
 * evicts the oldest past the cap; `add` returns true the first time an id is
 * seen and false thereafter — the guard against j7 re-sending the same
 * callout/trade across its ~30s delivery batches. Bounded so a long-running
 * process can't leak memory one id at a time.
 */
export class BoundedDeduper {
  private seen = new Set<string>();

  constructor(private readonly capacity: number) {}

  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.capacity) {
      // Set iteration is insertion-ordered, so the first entry is the oldest.
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }
}
