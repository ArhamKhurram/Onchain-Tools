import { describe, it, expect } from 'vitest';
import { consoleOriginPath, routes } from '../src/lib/routes';

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
    expect(consoleOriginPath('/feed')).toBe('/dashboard/feed');
  });

  it('prepends a slash to a bare path segment', () => {
    expect(consoleOriginPath('feed')).toBe('/dashboard/feed');
  });

  it('defaults to home when called with no argument', () => {
    expect(consoleOriginPath()).toBe('/dashboard/');
  });
});

describe('routes', () => {
  it('registers the sniper route', () => {
    expect(routes.sniper).toBe('/sniper');
  });

  it('registers the pumpfun route with a leading slash', () => {
    // The pump.fun tab's NavLink `to` is routes.pumpfun; a missing leading slash
    // would make it resolve relative to the current page (see the leading-slash
    // test below), landing the nav entry on e.g. /sniper/pumpfun.
    expect(routes.pumpfun).toBe('/pumpfun');
  });

  it('gives every route a leading slash', () => {
    // The bug this guards: routes.ts values carry a leading slash while the
    // <Route path> children in App.tsx deliberately do not. A value added
    // without the slash reads fine in App.tsx but produces a NavLink `to` that
    // resolves RELATIVE to the current page, so the nav entry silently lands on
    // /callers/sniper from the Callers page.
    for (const [name, path] of Object.entries(routes)) {
      expect(`${name}:${path.startsWith('/')}`).toBe(`${name}:true`);
    }
  });

  it('has no duplicate paths', () => {
    // Two names sharing a path means one page is unreachable through the nav.
    const paths = Object.values(routes);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
