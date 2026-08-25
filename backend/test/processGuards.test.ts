import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isRecoverableUncaughtException,
  guardAsyncHandler,
  describeError,
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

describe('describeError', () => {
  it('prefers the stack for Errors', () => {
    expect(describeError(new Error('with stack'))).toContain('with stack');
  });

  it('handles non-Error values without throwing', () => {
    expect(describeError({ a: 1 })).toBe('{"a":1}');
    expect(describeError(undefined)).toBe('undefined');
  });
});
