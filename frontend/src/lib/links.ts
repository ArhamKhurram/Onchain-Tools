/**
 * External links the console points at. Kept in one module so a domain change
 * is a one-line edit rather than a grep.
 *
 * The user guide is the `user-docs/` workspace (Astro Starlight) deployed to
 * its own Vercel project. `landing/src/constants.ts` carries a second copy of
 * this URL — the landing site and the console share no module, so the two are
 * duplicated on purpose. Change both together.
 */
export const USER_DOCS_URL = 'https://docs.onchaintools.tech';

/**
 * Deep-link into the guide. Pass a page path without leading/trailing slashes,
 * e.g. `docsUrl('connecting/discord')`. Starlight serves every page with a
 * trailing slash, so we add one.
 */
export function docsUrl(path = ''): string {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return clean ? `${USER_DOCS_URL}/${clean}/` : `${USER_DOCS_URL}/`;
}
