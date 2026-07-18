// FOMO (fomo.family) API client.
//
// Ported from the Outpost Discord bot and refactored into a credential-scoped
// class so OCT can run either:
//   - a single shared FOMO service account (creds from env), or
//   - one client per OCT user (creds loaded from the DB).
//
// fomo.family's API (prod-api.fomo.family) sits behind Cloudflare bot
// protection, so requests are issued from inside a real (stealth) Chromium
// page context rather than plain Node fetch. Auth is Privy: a long-lived
// refresh_token is exchanged for short-lived access JWTs.

import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import type { FomoCredentials, FomoCallResult, FomoTokenMetadata } from './types.js';
import { getFomoServiceClient, loadPersistedFomoRefreshToken } from './store.js';

chromium.use(stealth());

const BASE = 'https://prod-api.fomo.family';
const PRIVY_SESSIONS_URL = 'https://auth.privy.io/api/v1/sessions';
const DEBUG = process.env.DEBUG === 'true';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function debug(...args: any[]): void {
  if (DEBUG) console.log('[FOMO]', ...args);
}

async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

export class FomoClient {
  private creds: FomoCredentials;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private browserInit: Promise<Page> | null = null;
  private jwt: string | null = null;

  constructor(creds: FomoCredentials) {
    if (!creds?.refreshToken) {
      throw new Error('FomoClient requires a refreshToken.');
    }
    this.creds = creds;
  }

  /** Exchange the Privy refresh_token for a fresh access JWT. */
  async refreshJwt(): Promise<string> {
    const res = await fetch(PRIVY_SESSIONS_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: 'https://fomo.family',
        referer: 'https://fomo.family/',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-storage-access': 'active',
        authorization: `Bearer ${this.creds.privyToken || ''}`,
        'privy-app-id': this.creds.privyAppId || '',
        'privy-client': this.creds.privyClient || '',
        'privy-client-id': this.creds.privyClientId || '',
        'privy-ca-id': this.creds.privyCaId || '',
      },
      body: JSON.stringify({ refresh_token: this.creds.refreshToken }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Privy refresh failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const data: any = await res.json();
    const accessToken =
      data?.session?.access_token ||
      data?.session?.token ||
      data?.access_token ||
      data?.token;

    if (!accessToken) {
      debug('Privy response did not contain an access token.', JSON.stringify(data, null, 2).slice(0, 1000));
      throw new Error('No access token in Privy response');
    }

    // Privy rotates the refresh_token on each session call. Persist the new one
    // so the credential source stays fresh and never needs manual re-entry.
    const rotatedRefresh = data?.refresh_token || data?.session?.refresh_token;
    if (rotatedRefresh && rotatedRefresh !== this.creds.refreshToken) {
      this.creds.refreshToken = rotatedRefresh;
      if (this.onRefreshTokenRotated) {
        try {
          await this.onRefreshTokenRotated(rotatedRefresh);
        } catch (err) {
          console.warn('[FOMO] onRefreshTokenRotated handler threw:', (err as Error)?.message);
        }
      }
    }

    this.jwt = accessToken;
    return accessToken;
  }

  /**
   * Optional hook fired whenever Privy rotates the refresh token. Wire this to
   * persist the new token back to env/DB so it survives restarts.
   */
  onRefreshTokenRotated?: (newRefreshToken: string) => Promise<void> | void;

  /**
   * Adopt a refresh token from an external store (e.g. a persisted rotated
   * token loaded from the DB on startup). Clears the cached JWT so the next
   * call re-exchanges against the new token. Safe to call before init().
   */
  setRefreshToken(token: string): void {
    if (!token || token === this.creds.refreshToken) return;
    this.creds.refreshToken = token;
    this.jwt = null;
  }

  private buildCookies(): any[] {
    const cookies: any[] = [];
    const addCookie = (name: string | undefined, value: string | undefined, domain = '.fomo.family') => {
      if (!name || !value) return;
      cookies.push({ name, value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' });
    };
    addCookie('privy-token', this.creds.privyToken);
    addCookie('privy-session', this.creds.privySession);
    addCookie('cf_clearance', this.creds.cfClearance);
    addCookie('__cf_bm', this.creds.cfBm);
    addCookie('_cfuvid', this.creds.cfUvid);
    return cookies;
  }

  private async launchBrowser(): Promise<Page> {
    debug('Launching new Playwright browser (headless: true, stealth)...');
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,800',
      ],
    });
    try {
      const context = await browser.newContext({ userAgent: USER_AGENT });
      const newPage = await context.newPage();
      await newPage.setViewportSize({ width: 1280, height: 800 });

      const cookies = this.buildCookies();
      if (cookies.length > 0) {
        debug(`Injecting ${cookies.length} cookie(s).`);
        await context.addCookies(cookies);
      }

      debug('Navigating to https://fomo.family ...');
      try {
        const response = await newPage.goto('https://fomo.family', { waitUntil: 'domcontentloaded', timeout: 60000 });
        debug(`Navigation response status: ${response?.status()}`);
      } catch (err) {
        console.warn('[FOMO] Initial navigation did not settle (continuing — cookies are already injected):', (err as Error)?.message);
      }
      debug(`Page title: ${await newPage.title()}`);
      debug(`Page URL: ${newPage.url()}`);

      this.browser = browser;
      this.page = newPage;
      return newPage;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  async ensureBrowser(): Promise<Page> {
    if (this.page) return this.page;
    if (this.browserInit) return this.browserInit;

    this.browserInit = this.launchBrowser();
    try {
      return await this.browserInit;
    } catch (error) {
      this.page = null;
      throw error;
    } finally {
      this.browserInit = null;
    }
  }

  async init(): Promise<void> {
    await retry(async () => {
      await this.ensureBrowser();
      await this.refreshJwt();
    }, 3, 1500);
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.browser = null;
    this.page = null;
    this.jwt = null;
  }

  /** Low-level FOMO API call, executed inside the browser page to satisfy Cloudflare. */
  async call<T = any>(path: string, opts: { method?: string; body?: string | null } = {}): Promise<FomoCallResult<T>> {
    const page = await this.ensureBrowser();
    const method = opts.method || 'GET';
    const body = opts.body || null;

    if (!this.jwt) {
      await retry(() => this.refreshJwt(), 3, 1500);
    }

    debug(`Requesting: ${BASE}${path}`);

    const result = (await page.evaluate(
      async ({ url, method, body, jwt }: { url: string; method: string; body: string | null; jwt: string }) => {
        const headers: Record<string, string> = {
          'x-supported-chains': '1,56,143,8453,1399811149',
        };
        if (jwt) headers['authorization'] = `Bearer ${jwt}`;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
          headers['content-type'] = 'application/json';
        }

        try {
          const res = await fetch(url, { method, headers, body: body ?? undefined, cache: 'no-store' });
          const text = await res.text();
          let json: any = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          return { status: res.status, text, json };
        } catch (err: any) {
          return {
            status: 0,
            text: '',
            json: null,
            errorName: err?.name ?? 'Error',
            errorMessage: err?.message ?? String(err),
            errorStack: err?.stack ?? '',
          };
        }
      },
      { url: `${BASE}${path}`, method, body, jwt: this.jwt! },
    )) as FomoCallResult<T>;

    debug(`evaluate result — status: ${result.status}, errorName: ${result.errorName ?? 'none'}`);

    if (result.status === 401) {
      console.error('[FOMO] 401 Unauthorized — attempting JWT refresh...');
      this.jwt = null;
      await retry(() => this.refreshJwt(), 3, 1500);
    } else if (!result.status || result.status < 200 || result.status >= 300) {
      console.error('[FOMO]', result.text?.slice?.(0, 2000) ?? 'Non-OK response');
    }

    return result;
  }

  // --- High-level helpers (data only; no Discord formatting) ---

  async getTokenMetadata(tokenAddress: string, networkId: number): Promise<FomoTokenMetadata> {
    const filterResult = await this.call('/proxy/filterTokens', {
      method: 'POST',
      body: JSON.stringify([`${tokenAddress}:${networkId}`]),
    });

    const filterJson: any = filterResult?.json ?? {};
    const entries = Array.isArray(filterJson?.responseObject) ? filterJson.responseObject : [];
    const entry = entries.find(
      (e: any) => e?.token?.address === tokenAddress && Number(e?.token?.networkId) === Number(networkId),
    );

    if (entry?.token) {
      const info = entry.token.info || {};
      const social = entry.token.socialLinks || {};
      const icon = info.imageLargeUrl || info.imageSmallUrl || info.imageThumbUrl || info.imageBannerUrl;
      const parseNum = (v: any) => (typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : null);

      return {
        ticker: entry.token.symbol || info.symbol,
        name: entry.token.name || info.name,
        iconLink: icon,
        marketCap: parseNum(entry.marketCap) ?? parseNum(info.marketCap),
        price: parseNum(entry.priceUSD),
        description: info.description,
        twitter: social.twitter,
        telegram: social.telegram,
        website: social.website,
      };
    }

    return { ticker: null, name: null, iconLink: null, marketCap: null, price: null, description: null, twitter: null, telegram: null, website: null };
  }

  getTopHolders(tokenAddress: string, networkId: number) {
    const holdersQuery = encodeURIComponent(JSON.stringify([{ address: tokenAddress, networkId }]));
    return this.call(`/hodlers/top?tokens=${holdersQuery}`);
  }

  getTokenTheses(tokenAddress: string, networkId: number, threshold = 1000) {
    return this.call(`/feed/token/thesis?tokenAddress=${tokenAddress}&networkId=${networkId}&threshold=${threshold}`);
  }

  searchUsers(searchTerm: string) {
    return this.call(`/v2/users/fuzzy-search?searchTerm=${encodeURIComponent(searchTerm)}`);
  }

  getUserByHandle(userHandle: string) {
    return this.call(`/v2/users/userHandle/${encodeURIComponent(userHandle)}`);
  }

  getUserBalances(userId: string) {
    return this.call(`/v2/users/${userId}/balances`);
  }

  getLeaderboard(limit = 50, window?: '24h') {
    return this.call(window ? `/v2/leaderboard/${window}?limit=${limit}` : `/v2/leaderboard?limit=${limit}`);
  }

  getTradingActivity(limit = 50) {
    return this.call(`/feed/tradingActivity?limit=${limit}`);
  }

  getTokenAllowList() {
    return this.call('/tokenAllowList/detailed');
  }
}

function fomoCredentialsWithRefresh(refreshToken: string): FomoCredentials {
  return {
    refreshToken,
    privyAppId: process.env.FOMO_PRIVY_APP_ID,
    privyClient: process.env.FOMO_PRIVY_CLIENT,
    privyClientId: process.env.FOMO_PRIVY_CLIENT_ID,
    privyCaId: process.env.FOMO_PRIVY_CA_ID,
    privyToken: process.env.FOMO_PRIVY_TOKEN,
    privySession: process.env.FOMO_PRIVY_SESSION,
    cfClearance: process.env.FOMO_CF_CLEARANCE,
    cfBm: process.env.FOMO_CF_BM,
    cfUvid: process.env.FOMO_CF_UVID,
  };
}

/** Read shared-account FOMO credentials from process.env (env-only bootstrap). */
export function fomoCredentialsFromEnv(): FomoCredentials | null {
  const refreshToken = process.env.FOMO_REFRESH_TOKEN;
  if (!refreshToken) return null;
  return fomoCredentialsWithRefresh(refreshToken);
}

/** Resolve refresh token: DB first (survives rotation), then env fallback. */
export async function resolveFomoRefreshToken(): Promise<string | null> {
  const persisted = await loadPersistedFomoRefreshToken();
  if (persisted) return persisted;
  return process.env.FOMO_REFRESH_TOKEN || null;
}

let sharedClient: FomoClient | null = null;
let sharedClientInit: Promise<FomoClient | null> | null = null;

function wireRefreshTokenPersistence(client: FomoClient): void {
  const db = getFomoServiceClient();
  if (!db) return;
  client.onRefreshTokenRotated = async (newToken: string) => {
    try {
      await db.from('fomo_poll_state').update({ refresh_token: newToken }).eq('id', true);
      if (DEBUG) console.log('[FOMO] Persisted rotated refresh token.');
    } catch (err) {
      console.warn('[FOMO] Failed to persist rotated refresh token:', (err as Error)?.message);
    }
  };
}

/**
 * Lazily construct the process-wide shared FOMO client. Prefers the refresh
 * token persisted in fomo_poll_state so prod can run DB-only after a one-time
 * seed; falls back to FOMO_REFRESH_TOKEN for first boot.
 */
export async function ensureSharedFomoClient(): Promise<FomoClient | null> {
  if (sharedClient) return sharedClient;
  if (sharedClientInit) return sharedClientInit;

  sharedClientInit = (async () => {
    const refreshToken = await resolveFomoRefreshToken();
    if (!refreshToken) return null;
    const client = new FomoClient(fomoCredentialsWithRefresh(refreshToken));
    wireRefreshTokenPersistence(client);
    sharedClient = client;
    return client;
  })();

  try {
    return await sharedClientInit;
  } finally {
    sharedClientInit = null;
  }
}

/** Returns the shared client if already initialized (sync). */
export function getSharedFomoClient(): FomoClient | null {
  return sharedClient;
}
