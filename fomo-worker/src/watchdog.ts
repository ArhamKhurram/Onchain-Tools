// Hang watchdog — pure decision logic, no timers or process access.
//
// Incident 2026-08-11: a `page.goto` timeout left the browser context dead and
// every subsequent `page.evaluate` hanging forever. The process stayed alive,
// so systemd's `Restart=always` never fired — the worker served 45s timeouts
// to the backend for 18 hours until a manual `systemctl restart` fixed it in
// 15 seconds. The watchdog closes that gap: if `/v1/call` requests keep
// arriving but none completes, the worker exits and systemd restarts it clean.
//
// "Success" here means the worker finished handling a `/v1/call` — the browser
// round-trip completed — regardless of the upstream HTTP status. An upstream
// 404 is still proof the worker is alive; only a wedged worker stops
// completing calls entirely.

export interface WatchdogState {
  /** When a /v1/call last arrived (ms epoch). */
  lastRequestAt: number | null;
  /** When a /v1/call last completed (ms epoch). */
  lastSuccessAt: number | null;
  /**
   * Arrival time of the first request in the current no-success stretch;
   * null while there is no unanswered work.
   */
  stalledSinceAt: number | null;
}

export function initialWatchdogState(): WatchdogState {
  return { lastRequestAt: null, lastSuccessAt: null, stalledSinceAt: null };
}

/** A /v1/call arrived. Opens a stall window if none is open. */
export function noteRequest(state: WatchdogState, now: number): WatchdogState {
  return {
    ...state,
    lastRequestAt: now,
    stalledSinceAt: state.stalledSinceAt ?? now,
  };
}

/** A /v1/call completed. Closes the stall window. */
export function noteSuccess(state: WatchdogState, now: number): WatchdogState {
  return { ...state, lastSuccessAt: now, stalledSinceAt: null };
}

/**
 * Trip when requests have been arriving for at least `thresholdMs` without a
 * single one completing. Deliberately does NOT trip on quiet periods: if no
 * request has arrived within `thresholdMs` (overnight, poller disabled, ...)
 * the worker is idle, not hung, and restarting it would prove nothing.
 */
export function shouldExitForHang(
  state: WatchdogState,
  now: number,
  thresholdMs: number,
): boolean {
  if (thresholdMs <= 0) return false; // disabled
  if (state.stalledSinceAt === null) return false; // nothing unanswered
  if (state.lastRequestAt === null) return false; // defensive: no traffic ever
  if (now - state.stalledSinceAt < thresholdMs) return false; // stretch too short
  if (now - state.lastRequestAt > thresholdMs) return false; // traffic stopped: quiet
  return true;
}

/**
 * Does a tab-recycle failure mean the browser context itself is gone?
 * Playwright reports operations on a dead context/browser as e.g.
 * "browserContext.newPage: Target page, context or browser has been closed".
 * A dead browser is unrecoverable in-process — restart is the recovery.
 */
export function isBrowserDeathMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /has been closed|target closed|browser closed|browser has disconnected/i.test(message);
}
