// Always-on Playwright client with a persistent browser profile.

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright-extra';
import type { BrowserContext, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import type { FomoCallResult, FomoCredentials, FomoTokenMetadata } from './types.js';
import { persistRefreshToken } from './store.js';

chromium.use(stealth());

const BASE = 'https://prod-api.fomo.family';
const PRIVY_SESSIONS_URL = 'https://auth.privy.io/api/v1/sessions';
const DEBUG = process.env.DEBUG === 'true';

// The fomo.family SPA is a live app — sockets, timers, a growing React tree —
// so a tab left open for days climbs past 500 MB RSS. On a 1 GB VPS that ends
// in continuous swapping, which turns a 2s /hodlers/top into a 100s one and
// surfaces on Railway as `fetch failed`. Recycling the tab bounds that: the
// persistent context keeps the cookies, so a fresh tab needs no re-auth.
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const PAGE_MAX_AGE_MS = envInt('FOMO_PAGE_MAX_AGE_MS', 30 * 60 * 1000);
const PAGE_MAX_CALLS = envInt('FOMO_PAGE_MAX_CALLS', 200);

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function debug(...args: unknown[]): void {
  if (DEBUG) console.log('[FomoWorker]', ...args);
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

export function credentialsFromEnv(refreshToken: string): FomoCredentials {
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

export class FomoBrowserClient {
  private creds: FomoCredentials;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private browserInit: Promise<Page> | null = null;
  private recycleInit: Promise<void> | null = null;
  private jwt: string | null = null;
  private profileDir: string;
  private pageOpenedAt = 0;
  private callsOnPage = 0;
  private inFlight = 0;
  lastCallAt: Date | null = null;
  lastCallPath: string | null = null;
  lastError: string | null = null;

  constructor(creds: FomoCredentials, profileDir: string) {
    if (!creds?.refreshToken) throw new Error('FomoBrowserClient requires refreshToken.');
    this.creds = creds;
    this.profileDir = profileDir;
  }

  get browserReady(): boolean {
    return !!this.page;
  }

  get jwtReady(): boolean {
    return !!this.jwt;
  }

  /** Seconds the current tab has been open — health-check signal that recycling runs. */
  get pageAgeSec(): number | null {
    return this.pageOpenedAt ? Math.floor((Date.now() - this.pageOpenedAt) / 1000) : null;
  }

  get callsSincePageOpen(): number {
    return this.callsOnPage;
  }

  setRefreshToken(token: string): void {
    if (!token || token === this.creds.refreshToken) return;
    this.creds.refreshToken = token;
    this.jwt = null;
  }

  private buildCookies(): Array<Record<string, unknown>> {
    const cookies: Array<Record<string, unknown>> = [];
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
    fs.mkdirSync(this.profileDir, { recursive: true });
    debug('Launching persistent Chromium profile at', this.profileDir);

    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: true,
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Memory guards for the 1 GB VPS — see the recycling note above.
        '--disable-dev-shm-usage',
        '--renderer-process-limit=1',
        '--js-flags=--max-old-space-size=256',
        '--mute-audio',
      ],
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());

      const cookies = this.buildCookies();
      if (cookies.length > 0) {
        debug(`Injecting ${cookies.length} bootstrap cookie(s).`);
        await context.addCookies(cookies as any);
      }

      await this.preparePage(page);

      this.context = context;
      this.page = page;
      this.pageOpenedAt = Date.now();
      this.callsOnPage = 0;
      return page;
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  /** Size a tab and park it on the fomo.family origin so in-page fetch carries its cookies. */
  private async preparePage(page: Page): Promise<void> {
    await page.setViewportSize({ width: 1280, height: 800 });
    debug('Navigating to https://fomo.family ...');
    try {
      const response = await page.goto('https://fomo.family', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      debug(`Navigation status: ${response?.status()}`);
    } catch (err) {
      console.warn(
        '[FomoWorker] Navigation did not settle (continuing):',
        (err as Error)?.message,
      );
    }
  }

  private pageIsStale(): boolean {
    if (!this.page) return false;
    if (PAGE_MAX_CALLS > 0 && this.callsOnPage >= PAGE_MAX_CALLS) return true;
    if (PAGE_MAX_AGE_MS > 0 && Date.now() - this.pageOpenedAt >= PAGE_MAX_AGE_MS) return true;
    return false;
  }

  /** Swap in a fresh tab, dropping the old renderer's accumulated heap. */
  private async recyclePage(): Promise<void> {
    if (this.recycleInit) return this.recycleInit;

    this.recycleInit = (async () => {
      const context = this.context;
      if (!context) return;

      const stale = this.page;
      debug(`Recycling tab after ${this.callsOnPage} call(s), age ${this.pageAgeSec}s.`);

      // Open the replacement before closing the old tab: closing the last page
      // of a persistent context can take the context down with it.
      const fresh = await context.newPage();
      await this.preparePage(fresh);
      this.page = fresh;
      this.pageOpenedAt = Date.now();
      this.callsOnPage = 0;

      try {
        await stale?.close();
      } catch {
        /* ignore */
      }
    })();

    try {
      await this.recycleInit;
    } finally {
      this.recycleInit = null;
    }
  }

  async ensureBrowser(): Promise<Page> {
    if (this.page) return this.page;
    if (this.browserInit) return this.browserInit;
    this.browserInit = this.launchBrowser();
    try {
      return await this.browserInit;
    } finally {
      this.browserInit = null;
    }
  }

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
      throw new Error('No access token in Privy response');
    }

    const rotatedRefresh = data?.refresh_token || data?.session?.refresh_token;
    if (rotatedRefresh && rotatedRefresh !== this.creds.refreshToken) {
      this.creds.refreshToken = rotatedRefresh;
      try {
        await persistRefreshToken(rotatedRefresh);
        debug('Persisted rotated refresh token to Supabase.');
      } catch (err) {
        console.warn('[FomoWorker] Failed to persist rotated token:', (err as Error)?.message);
      }
    }

    this.jwt = accessToken;
    return accessToken;
  }

  async init(): Promise<void> {
    await retry(async () => {
      await this.ensureBrowser();
      await this.refreshJwt();
    }, 3, 1500);
    this.lastError = null;
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    this.context = null;
    this.page = null;
    this.jwt = null;
    this.pageOpenedAt = 0;
    this.callsOnPage = 0;
    this.inFlight = 0;
  }

  async call<T = any>(
    apiPath: string,
    opts: { method?: string; body?: string | null } = {},
  ): Promise<FomoCallResult<T>> {
    await this.ensureBrowser();
    const method = opts.method || 'GET';
    const body = opts.body || null;

    // Never hand out a tab a recycle is about to close.
    while (this.recycleInit) {
      await this.recycleInit.catch(() => undefined);
    }

    // Only recycle when nothing is mid-evaluate: the poller fires ~20 calls at
    // once, and closing the tab under them fails every one with "Target page,
    // context or browser has been closed". The thresholds are not deadlines,
    // so waiting for the next idle moment costs nothing.
    if (this.pageIsStale() && this.inFlight === 0) {
      try {
        await this.recyclePage();
      } catch (err) {
        // A failed recycle is not worth failing the call over — the old tab
        // still works, it is just fatter than we would like.
        console.warn('[FomoWorker] Tab recycle failed (keeping current tab):', (err as Error)?.message);
      }
    }

    if (!this.jwt) {
      await retry(() => this.refreshJwt(), 3, 1500);
    }

    // Claim the tab only after every await above has settled, so no concurrent
    // recycle can slip in between reading this.page and page.evaluate.
    const page = this.page ?? (await this.ensureBrowser());
    this.inFlight += 1;
    this.callsOnPage += 1;
    this.lastCallPath = apiPath;
    this.lastCallAt = new Date();

    let result: FomoCallResult<T>;
    try {
      result = (await page.evaluate(
        async ({ url, method, body, jwt }: { url: string; method: string; body: string | null; jwt: string }) => {
          const headers: Record<string, string> = {
            'x-supported-chains': '1,56,143,8453,1399811149',
          };
          if (jwt) headers.authorization = `Bearer ${jwt}`;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            headers['content-type'] = 'application/json';
          }

          try {
            const res = await fetch(url, { method, headers, body: body ?? undefined, cache: 'no-store' });
            const text = await res.text();
            let json: any = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* not json */
            }
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
        { url: `${BASE}${apiPath}`, method, body, jwt: this.jwt! },
      )) as FomoCallResult<T>;
    } finally {
      this.inFlight -= 1;
    }

    if (result.status === 401) {
      this.jwt = null;
      await retry(() => this.refreshJwt(), 3, 1500);
      this.lastError = '401 — refreshed JWT';
    } else if (!result.status || result.status < 200 || result.status >= 300) {
      // A throw inside page.evaluate comes back as status 0 with an empty body,
      // which used to log as a bare path and nothing else. Prefer the real error.
      this.lastError = result.errorMessage
        ? `${result.errorName ?? 'Error'}: ${result.errorMessage}`
        : result.text?.slice?.(0, 500) || `HTTP ${result.status}`;
      console.error('[FomoWorker]', apiPath, this.lastError);
    } else {
      this.lastError = null;
    }

    return result;
  }

  getTopHolders(tokenAddress: string, networkId: number) {
    const holdersQuery = encodeURIComponent(JSON.stringify([{ address: tokenAddress, networkId }]));
    return this.call(`/hodlers/top?tokens=${holdersQuery}`);
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

  getUserActivity(userId: string, limit = 20) {
    return this.call(`/v2/users/${encodeURIComponent(userId)}/activity?limit=${limit}`);
  }

  getTokenAllowList() {
    return this.call('/tokenAllowList/detailed');
  }
}

export function resolveProfileDir(): string {
  const configured = process.env.FOMO_PROFILE_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), 'data', 'profile');
}
