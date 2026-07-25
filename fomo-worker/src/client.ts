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
  private jwt: string | null = null;
  private profileDir: string;
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
      ],
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.setViewportSize({ width: 1280, height: 800 });

      const cookies = this.buildCookies();
      if (cookies.length > 0) {
        debug(`Injecting ${cookies.length} bootstrap cookie(s).`);
        await context.addCookies(cookies as any);
      }

      debug('Navigating to https://fomo.family ...');
      try {
        const response = await page.goto('https://fomo.family', {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        debug(`Navigation status: ${response?.status()}`);
      } catch (err) {
        console.warn(
          '[FomoWorker] Initial navigation did not settle (continuing):',
          (err as Error)?.message,
        );
      }

      this.context = context;
      this.page = page;
      return page;
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
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
  }

  async call<T = any>(
    apiPath: string,
    opts: { method?: string; body?: string | null } = {},
  ): Promise<FomoCallResult<T>> {
    const page = await this.ensureBrowser();
    const method = opts.method || 'GET';
    const body = opts.body || null;

    if (!this.jwt) {
      await retry(() => this.refreshJwt(), 3, 1500);
    }

    this.lastCallPath = apiPath;
    this.lastCallAt = new Date();

    const result = (await page.evaluate(
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

    if (result.status === 401) {
      this.jwt = null;
      await retry(() => this.refreshJwt(), 3, 1500);
      this.lastError = '401 — refreshed JWT';
    } else if (!result.status || result.status < 200 || result.status >= 300) {
      this.lastError = result.text?.slice?.(0, 500) ?? `HTTP ${result.status}`;
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
