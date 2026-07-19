/** Console SPA entry — served at /dashboard in prod; proxied in landing dev. */
export const APP_CONSOLE_PATH = '/dashboard/';
export const appConsolePath = (segment = '') =>
  `${APP_CONSOLE_PATH}${segment.replace(/^\//, '')}`;
