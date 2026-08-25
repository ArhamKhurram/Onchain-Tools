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
//   uncaughtException   -> FATAL by default. Log loudly, exit(1).
//     A synchronous throw unwound an arbitrary stack, possibly halfway through
//     mutating a shared Map or store. Continuing would serve state we cannot
//     vouch for, which is strictly worse than a restart: Railway restarts the
//     container and desktop already watches `backendProcess.on('exit')`.
//     Note this is also the *pre-existing* behaviour, so the fatal branch is a
//     no-op change — the guard only ever removes crashes, never adds one.
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
    if (isRecoverableUncaughtException(err)) {
      console.error(`[Process] Transient ${origin}, continuing to serve:`, describeError(err));
      return;
    }
    console.error(
      `[Process] Fatal ${origin}, shutting down so a clean process is restarted:`,
      describeError(err),
    );
    process.exitCode = 1;
    // Give stderr a moment to flush (it is async when piped on Linux) without
    // ever hanging: the timer is unref'd, so if the loop drains first we exit
    // with the code above anyway.
    setTimeout(() => process.exit(1), 100).unref();
  });
}
