/** Console SPA entry — served at /dashboard in prod; proxied in landing dev. */
export const APP_CONSOLE_PATH = '/dashboard/';
export const appConsolePath = (segment = '') =>
  `${APP_CONSOLE_PATH}${segment.replace(/^\//, '')}`;

/** Public socials. Single source of truth — link from here, don't inline URLs. */
export const SOCIAL_X_URL = 'https://x.com/toolsonchain';
export const SOCIAL_X_HANDLE = '@toolsonchain';
