import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isRecoverableUncaughtException,
  guardAsyncHandler,
  describeError,
  handleUncaughtException,
} from '../src/utils/processGuards.js';

function errWithCode(code: string, message = 'boom'): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isRecoverableUncaughtException', () => {
  it('survives transient socket errors', () => {
    expect(isRecoverableUncaughtException(errWithCode('ECONNRESET'))).toBe(true);
    expect(isRecoverableUncaughtException(errWithCode('EPIPE'))).toBe(true);
    expect(isRecoverableUncaughtException(errWithCode('ETIMEDOUT'))).toBe(true);
  });

  it('is fatal for application errors that carry no code', () => {
    expect(isRecoverableUncaughtException(new TypeError('x is not a function'))).toBe(false);
    expect(isRecoverableUncaughtException(new Error('assertion failed'))).toBe(false);
  });

  it('is fatal for codes that signal a broken deploy or corrupt state', () => {
    expect(isRecoverableUncaughtException(errWithCode('ERR_MODULE_NOT_FOUND'))).toBe(false);
    expect(isRecoverableUncaughtException(errWithCode('ERR_UNHANDLED_ERROR'))).toBe(false);
    expect(isRecoverableUncaughtException(errWithCode('EADDRINUSE'))).toBe(false);
  });

  it('is fatal for non-Error throws', () => {
    expect(isRecoverableUncaughtException('nope')).toBe(false);
    expect(isRecoverableUncaughtException(undefined)).toBe(false);
  });

  it('refuses to survive a recoverable code wrapping an unrecognised cause', () => {
    const wrapped = errWithCode('ECONNRESET');
    (wrapped as { cause?: unknown }).cause = errWithCode('ERR_INTERNAL_ASSERTION');
    expect(isRecoverableUncaughtException(wrapped)).toBe(false);
  });

  it('survives when the whole cause chain is transient', () => {
    const wrapped = errWithCode('ECONNRESET');
    (wrapped as { cause?: unknown }).cause = errWithCode('ETIMEDOUT');
    expect(isRecoverableUncaughtException(wrapped)).toBe(true);
  });

  it('inspects AggregateError members', () => {
    const allTransient = new AggregateError([errWithCode('ECONNREFUSED'), errWithCode('EHOSTUNREACH')]);
    (allTransient as NodeJS.ErrnoException).code = 'EAI_AGAIN';
    expect(isRecoverableUncaughtException(allTransient)).toBe(true);

    const mixed = new AggregateError([errWithCode('ECONNREFUSED'), errWithCode('ERR_INVALID_STATE')]);
    (mixed as NodeJS.ErrnoException).code = 'EAI_AGAIN';
    expect(isRecoverableUncaughtException(mixed)).toBe(false);
  });
});

describe('guardAsyncHandler', () => {
  it('swallows a rejection so the emitter never sees an unhandled promise', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let settled: () => void = () => {};
    const done = new Promise<void>((resolve) => { settled = resolve; });

    const wrapped = guardAsyncHandler('Test:ingest', async () => {
      try {
        throw new Error('supabase timed out');
      } finally {
        queueMicrotask(settled);
      }
    });

    expect(() => wrapped()).not.toThrow();
    await done;
    await Promise.resolve();

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toContain('Test:ingest');
    expect(String(spy.mock.calls[0][1])).toContain('supabase timed out');
  });

  it('passes arguments through on the happy path', async () => {
    const seen: unknown[] = [];
    const wrapped = guardAsyncHandler('Test:ingest', async (a: string, b: number) => {
      seen.push(a, b);
    });
    wrapped('msg', 7);
    await Promise.resolve();
    expect(seen).toEqual(['msg', 7]);
  });

  it('catches a synchronous throw from a non-async handler', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = guardAsyncHandler('Test:sync', (() => {
      throw new Error('sync boom');
    }) as () => Promise<void>);

    expect(() => wrapped()).not.toThrow();
    expect(String(spy.mock.calls[0][1])).toContain('sync boom');
  });
});

describe('handleUncaughtException', () => {
  function hooks() {
    const written: string[] = [];
    const exits: number[] = [];
    return {
      written,
      exits,
      hooks: {
        write: (line: string) => { written.push(line); },
        exit: (code: number) => { exits.push(code); },
      },
    };
  }

  it('exits synchronously on a fatal error, leaving no window for the loop to turn', () => {
    const h = hooks();
    const timer = vi.spyOn(global, 'setTimeout');

    const verdict = handleUncaughtException(new TypeError('x is not a function'), 'uncaughtException', h.hooks);

    // Synchronously, before this assertion runs — not deferred behind a timer.
    // Any delay here keeps the HTTP server (and with it /sniper/v1) answering on
    // a process that just declared its own state untrustworthy.
    expect(verdict).toBe('fatal');
    expect(h.exits).toEqual([1]);
    expect(timer).not.toHaveBeenCalled();
  });

  it('writes the reason before exiting, via the injected sync writer not console', () => {
    const h = hooks();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    handleUncaughtException(new TypeError('boom'), 'uncaughtException', h.hooks);

    expect(h.written).toHaveLength(1);
    expect(h.written[0]).toContain('boom');
    expect(h.written[0]).toContain('Fatal uncaughtException');
    // console.error buffers when stderr is a pipe, so the fatal line must not
    // depend on it.
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('survives a transient transport error without exiting', () => {
    const h = hooks();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const verdict = handleUncaughtException(errWithCode('ECONNRESET'), 'uncaughtException', h.hooks);

    expect(verdict).toBe('survived');
    expect(h.exits).toEqual([]);
    expect(h.written).toEqual([]);
  });
});

describe('describeError', () => {
  it('prefers the stack for Errors', () => {
    expect(describeError(new Error('with stack'))).toContain('with stack');
  });

  it('handles non-Error values without throwing', () => {
    expect(describeError({ a: 1 })).toBe('{"a":1}');
    expect(describeError(undefined)).toBe('undefined');
  });
});
