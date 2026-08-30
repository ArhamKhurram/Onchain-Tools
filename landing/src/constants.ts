/** Console SPA entry — served at /dashboard in prod; proxied in landing dev. */
export const APP_CONSOLE_PATH = '/dashboard/';

/**
 * The user guide (Astro Starlight, `user-docs/`, its own Vercel project).
 * Single source of truth for the URL — the console has its own copy in
 * `frontend/src/lib/links.ts` because the two apps share no module.
 */
export const USER_DOCS_URL = 'https://docs.onchaintools.tech';

/** Public socials. Single source of truth — link from here, don't inline URLs. */
export const SOCIAL_X_URL = 'https://x.com/toolsonchain';
export const SOCIAL_X_HANDLE = '@toolsonchain';
export const SOCIAL_DISCORD_URL = 'https://discord.gg/f8HGPgdyTQ';
