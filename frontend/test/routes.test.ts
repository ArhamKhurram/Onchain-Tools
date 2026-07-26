import { describe, it, expect } from 'vitest';
import { consoleOriginPath } from '../src/lib/routes';

// This standalone vitest config has no `base`, so import.meta.env.BASE_URL is
// Vite's default '/' here, which makes consoleOriginPath fall through to its
// own '/dashboard' fallback (routes.ts line: `|| '/dashboard'`). That fallback
// is the same value the real app's vite.config.ts sets as `base`, so asserting
// against '/dashboard/' below still exercises the trailing-slash logic that
// matters, without needing to fake import.meta.env (which isn't mockable via
// vi.stubGlobal — it's compiled in by Vite, not a runtime global).

describe('consoleOriginPath', () => {
  it('resolves "/" to the base WITH its trailing slash', () => {
    // The bug this guards: returning '/dashboard' (no slash) for '/' produces
    // an OAuth redirectTo that mismatches Vite's `base: '/dashboard/'` — the
    // dev server refuses to serve it and the access_token fragment is lost.
    expect(consoleOriginPath('/')).toBe('/dashboard/');
  });

  it('resolves a named route under the base with a single slash, not doubled', () => {
    expect(consoleOriginPath('/lp')).toBe('/dashboard/lp');
  });

  it('prepends a slash to a bare path segment', () => {
    expect(consoleOriginPath('lp')).toBe('/dashboard/lp');
  });

  it('defaults to home when called with no argument', () => {
    expect(consoleOriginPath()).toBe('/dashboard/');
  });
});
