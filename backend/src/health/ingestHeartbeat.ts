// "When did a message last arrive from an upstream feed?" — one number, set on
// the hot ingest path and read by GET /health/deep.
//
// Deliberately its own module so the Discord/Telegram message handlers depend on
// nothing but this counter; the readiness collector imports it, not the reverse.
//
// It is a heartbeat, not a metric: recorded BEFORE room gating, because the fact
// worth knowing is "the gateway is delivering traffic", not "the traffic matched
// a room". Resets on process restart.

let lastIngestAtMs: number | null = null;

export function recordIngest(atMs: number = Date.now()): void {
  lastIngestAtMs = atMs;
}

export function getLastIngestAtMs(): number | null {
  return lastIngestAtMs;
}

/** Test hook — the module-level state otherwise leaks between specs. */
export function resetIngestHeartbeat(): void {
  lastIngestAtMs = null;
}
