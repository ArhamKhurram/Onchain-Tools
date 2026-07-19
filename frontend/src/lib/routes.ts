/** App routes — use with React Router basename `/dashboard`. */
export const routes = {
  home: '/',
  feed: '/feed',
  wallets: '/wallets',
  callers: '/callers',
  settings: '/settings',
  login: '/login',
} as const;

/** Marketing site root (outside the console SPA). */
export const LANDING_URL = '/';

export function consoleOriginPath(pathname: string = routes.home): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '') || '/dashboard';
  if (pathname === '/') return base;
  return `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}
