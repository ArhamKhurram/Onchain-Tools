/**
 * The poller must stop retrying a request that can never succeed.
 *
 * pump.fun removed the global callouts firehose: `/callout/recent` returns 400
 * `Validation failed (uuid is expected)` because `recent` is now matched as a `:uuid` path
 * parameter, and every path under `/callout/` behaves the same way. There is no list route left.
 *
 * Before this guard the poller retried it every 12 seconds indefinitely. In production that was a
 * continuous error every few seconds and thousands of futile requests a day, against a vendor who
 * had already told us the request was malformed.
 */

import { describe, expect, it } from 'vitest';

import { isPermanentContractFailure } from '../src/pumpfun/calloutPoller.js';

describe('isPermanentContractFailure', () => {
  it('treats the actual failure that broke the feed as permanent', () => {
    // 400 Validation failed (uuid is expected) — observed in production 2026-08-28.
    expect(isPermanentContractFailure(400)).toBe(true);
  });

  it('treats a removed route as permanent', () => {
    expect(isPermanentContractFailure(404)).toBe(true);
    expect(isPermanentContractFailure(401)).toBe(true);
    expect(isPermanentContractFailure(403)).toBe(true);
  });

  it('does NOT give up on rate limiting — that is the right request at the wrong pace', () => {
    expect(isPermanentContractFailure(429)).toBe(false);
  });

  it('does NOT give up on vendor-side errors', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isPermanentContractFailure(status)).toBe(false);
    }
  });

  it('does not treat success as a failure', () => {
    for (const status of [200, 201, 204, 304]) {
      expect(isPermanentContractFailure(status)).toBe(false);
    }
  });

  it('treats an unknown status as transient rather than fatal', () => {
    // A network error carries no status. Killing a working feed over one is worse than retrying.
    expect(isPermanentContractFailure(null)).toBe(false);
    expect(isPermanentContractFailure(undefined)).toBe(false);
  });
});
