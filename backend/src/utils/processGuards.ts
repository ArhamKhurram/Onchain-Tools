// Process-level error guards.
//
// Node 15+ defaults `--unhandled-rejections=throw`: a promise that rejects with
// nobody attached is escalated to an uncaughtException and, with no handler
// installed, the process dies. The backend serves every user from one process,
// so a single transient failure inside one user's ingest handler took down
// Discord, Telegram, the WebSocket fan-out and the REST API for everyone.
//
// The policy here is deliberately asymmetric, because the two failure modes say
// very different things about how much of the process is still trustworthy:
//
//   unhandledRejection  -> ALWAYS recoverable. Log loudly, keep serving.
//     A rejected promise never unwound a synchronous stack through unrelated
//     code; the failure is contained to one async task's continuation. In this
//     codebase every such task is a single message, poll tick or broadcast, so
//     the blast radius of continuing is exactly one dropped event.
//
//   uncaughtException   -> FATAL by default. Log loudly, exit(1) IMMEDIATELY.
//     A synchronous throw unwound an arbitrary stack, possibly halfway through
//     mutating a shared Map or store. Continuing would serve state we cannot
//     vouch for, which is strictly worse than a restart: Railway restarts the
//     container and desktop already watches `backendProcess.on('exit')`.
//
//     "Immediately" is load-bearing, not a detail. Merely *registering* an
//     `uncaughtException` listener replaces Node's default terminate-at-the-throw
//     behaviour, so any deferred exit — `process.exitCode = 1` plus a timer, say —
//     hands the event loop a window in which timers still fire and the HTTP
//     server still answers requests, on a process that has just declared its own
//     state untrustworthy. `/sniper/v1` (the one route that spends money) is
//     mounted on that same server. Measured on Node v22.15.0 with a listening
//     http server, a 100ms deferred exit served a request and ran two timers
//     inside a 110ms window; the synchronous exit below closes it to ~0ms,
//     matching what Node's own default handler does.
//
//     The fatal log therefore goes out via `fs.writeSync(2, ...)` rather than
//     `console.error`: stderr is asynchronous when piped, so a buffered write
//     would be dropped by an immediate `process.exit`. Writing straight to the
//     descriptor is what lets the exit be immediate without losing the reason.
//
//     The single carve-out is transient socket/DNS failures surfaced from
//     Node's own I/O layer because a stream had no 'error' listener. Those
//     carry no application state and are the most common cause of spurious
//     production restarts, so they lose a connection instead of the process.
//
// Anything that looks like genuine corruption or a broken deploy — a bad
// module, a failed assertion, a TypeError, an EventEmitter 'error' with no
// listener — falls through to the fatal branch on purpose. It is never
// swallowed.

import { writeSync } from 'fs';

/**
 * Error codes we are willing to survive as an uncaught exception. Every entry
 * is a transport-layer failure raised by Node's networking stack, not by
 * application logic.
 */
const RECOVERABLE_UNCAUGHT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

const MAX_CAUSE_DEPTH = 4;

function collectErrorCodes(err: unknown, out: Set<string>, depth = 0): void {
  if (depth > MAX_CAUSE_DEPTH || !(err instanceof Error)) return;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === 'string') out.add(code);
  if (err instanceof AggregateError) {
    for (const inner of err.errors) collectErrorCodes(inner, out, depth + 1);
  }
  collectErrorCodes((err as { cause?: unknown }).cause, out, depth + 1);
}

/**
 * True only when the error carries at least one code and *every* code in its
 * cause chain is on the allow-list. A socket reset wrapped around something we
 * do not recognise is not automatically safe to survive.
 */
export function isRecoverableUncaughtException(err: unknown): boolean {
  const codes = new Set<string>();
  collectErrorCodes(err, codes);
  if (codes.size === 0) return false;
  for (const code of codes) {
    if (!RECOVERABLE_UNCAUGHT_CODES.has(code)) return false;
  }
  return true;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Wrap an async EventEmitter listener so a failure drops that one event instead
 * of rejecting into the process guard. EventEmitter invokes listeners
 * synchronously and discards the returned promise, so an unwrapped
 * `async (msg) => { await ... }` listener has no rejection handler at all.
 */
export function guardAsyncHandler<Args extends unknown[]>(
  label: string,
  handler: (...args: Args) => Promise<void>,
): (...args: Args) => void {
  const onError = (err: unknown): void => {
    console.error(`[${label}] handler failed, dropping this event:`, describeError(err));
  };
  return (...args: Args): void => {
    try {
      void handler(...args).catch(onError);
    } catch (err) {
      // An `async` function cannot throw synchronously, but a plain function
      // typed as returning a promise can. Treat both the same way.
      onError(err);
    }
  };
}

/**
 * Write one line straight to fd 2, bypassing the `process.stderr` stream.
 *
 * `console.error` queues onto a stream that is asynchronous whenever stderr is a
 * pipe (Railway, the desktop fork, `npm start | tee`), so anything written that
 * way is lost if the process exits in the same tick. Writing to the descriptor
 * is synchronous, which is what makes an immediate `process.exit` safe.
 */
export function writeStderrSync(line: string): void {
  const buf = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
  let offset = 0;
  // A non-blocking pipe can refuse the write with EAGAIN. Retry a bounded number
  // of times, then drop the rest of the line — a truncated log is a far smaller
  // problem than delaying the exit.
  for (let attempt = 0; attempt < 64 && offset < buf.length; attempt += 1) {
    try {
      offset += writeSync(2, buf, offset, buf.length - offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      return;
    }
  }
}

/** Injection seam so the fatal path is testable without killing the test runner. */
export interface UncaughtExceptionHooks {
  write: (line: string) => void;
  exit: (code: number) => never | void;
}

const defaultHooks: UncaughtExceptionHooks = {
  write: writeStderrSync,
  exit: (code) => process.exit(code),
};

/**
 * Decide and act on an uncaught exception. Returns `'survived'` when the error
 * was a transient transport failure; otherwise it logs synchronously and exits
 * without ever yielding to the event loop, so no further request, timer or
 * callback runs on a process whose state we no longer trust.
 */
export function handleUncaughtException(
  err: unknown,
  origin: string,
  hooks: UncaughtExceptionHooks = defaultHooks,
): 'survived' | 'fatal' {
  if (isRecoverableUncaughtException(err)) {
    console.error(`[Process] Transient ${origin}, continuing to serve:`, describeError(err));
    return 'survived';
  }
  hooks.write(
    `[Process] Fatal ${origin}, exiting now so a clean process is restarted: ${describeError(err)}`,
  );
  hooks.exit(1);
  return 'fatal';
}

let installed = false;

/**
 * Install the process-level guards. Idempotent — safe to call from more than
 * one entry point.
 */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[Process] Unhandled promise rejection, continuing to serve:', describeError(reason));
  });

  process.on('uncaughtException', (err: Error, origin: string) => {
    handleUncaughtException(err, origin);
  });
}
