/** App routes — use with React Router basename `/dashboard`. */
export const routes = {
  home: '/',
  feed: '/feed',
  wallets: '/wallets',
  portfolio: '/portfolio',
  callers: '/callers',
  workspace: '/workspace',
  settings: '/settings',
  login: '/login',
} as const;

/** Marketing site root (outside the console SPA). */
export const LANDING_URL = '/';

export function consoleOriginPath(pathname: string = routes.home): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '') || '/dashboard';
  // A bare '/' must resolve to the base WITH its trailing slash — the base
  // itself already has no path segment left to append to. Returning `base`
  // alone (no slash) doesn't match Vite's `base: '/dashboard/'` config, which
  // is exactly what an OAuth redirectTo built from this needs to land on:
  // stripping the slash sends the user to a URL Vite's dev server refuses to
  // serve, dropping the access_token fragment from the auth callback.
  if (pathname === '/') return `${base}/`;
  return `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
