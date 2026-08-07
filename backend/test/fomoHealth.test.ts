import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCloudflareShaped,
  recordFomoUpstreamError,
  recordFomoUpstreamSuccess,
  getFomoUpstreamHealth,
  resetFomoUpstreamHealth,
} from '../src/fomo/health.js';
import { getCached, setCached, getFomoCacheStats, resetFomoCache } from '../src/fomo/cache.js';

describe('isCloudflareShaped', () => {
  // Status 0 = the in-page fetch threw before any response arrived — the
  // canonical signature of a Cloudflare challenge blocking the request.
  it('treats a missing status as Cloudflare interference', () => {
    expect(isCloudflareShaped(0, '')).toBe(true);
    expect(isCloudflareShaped(null, 'TypeError: Failed to fetch')).toBe(true);
  });

  it('recognises Cloudflare-branded error pages', () => {
    expect(isCloudflareShaped(502, '<title>fomo.family | 502: Bad gateway</title> ... cloudflare')).toBe(true);
    expect(isCloudflareShaped(403, 'Just a moment...')).toBe(true);
    expect(isCloudflareShaped(503, 'challenge-platform script')).toBe(true);
  });

  it('does not flag the FOMO API erroring in its own voice', () => {
    expect(isCloudflareShaped(401, '{"success":false,"message":"JWT token expired"}')).toBe(false);
    expect(isCloudflareShaped(429, '{"error":"rate limited"}')).toBe(false);
    expect(isCloudflareShaped(500, '')).toBe(false);
  });
});

describe('fomo upstream health recorder', () => {
  beforeEach(() => resetFomoUpstreamHealth());

  it('starts empty', () => {
    expect(getFomoUpstreamHealth()).toEqual({
      lastSuccessAt: null,
      lastError: null,
      lastCloudflareError: null,
      successCount: 0,
      errorCount: 0,
    });
  });

  it('tracks the latest error and separates Cloudflare-shaped ones', () => {
    recordFomoUpstreamError('/v2/leaderboard', 502, 'HTTP 502', 'cloudflare 502 page');
    recordFomoUpstreamError('/v2/users/x/activity', 401, 'JWT token expired');

    const health = getFomoUpstreamHealth();
    expect(health.errorCount).toBe(2);
    expect(health.lastError?.status).toBe(401);
    expect(health.lastError?.cloudflare).toBe(false);
    // The 401 did not overwrite the last *Cloudflare* error.
    expect(health.lastCloudflareError?.status).toBe(502);
    expect(health.lastCloudflareError?.source).toBe('/v2/leaderboard');
  });

  it('counts successes and stamps lastSuccessAt', () => {
    recordFomoUpstreamSuccess();
    recordFomoUpstreamSuccess();
    const health = getFomoUpstreamHealth();
    expect(health.successCount).toBe(2);
    expect(health.lastSuccessAt).toBeTruthy();
  });

  it('truncates unbounded error messages', () => {
    recordFomoUpstreamError('/x', 500, 'a'.repeat(2000));
    expect(getFomoUpstreamHealth().lastError?.message).toHaveLength(500);
  });
});

describe('fomo cache stats', () => {
  beforeEach(() => resetFomoCache());

  it('counts hits, misses and live entries', () => {
    expect(getCached('missing')).toBeNull();
    setCached('k', { v: 1 }, 60_000);
    expect(getCached('k')).toEqual({ v: 1 });
    expect(getFomoCacheStats()).toEqual({ size: 1, hits: 1, misses: 1 });
  });

  it('counts an expired entry as a miss and evicts it', () => {
    setCached('stale', 'x', -1);
    expect(getCached('stale')).toBeNull();
    expect(getFomoCacheStats()).toEqual({ size: 0, hits: 0, misses: 1 });
  });
});
