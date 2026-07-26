// Thin typed HTTP client for Krystal's public API.
//
// Krystal needs no API key: `securitySchemes` and `security` are both null in
// their OpenAPI spec, and every endpoint used here answers unauthenticated.
// That makes rate limits — not auth — the operational risk (plan §11 item 2).
//
// Scope: this module performs network I/O and nothing else. It does not know
// what a pool or a position is, and it never interprets a payload. Mapping
// lives in `pools.ts` / `positions.ts` as pure functions so it is unit-testable
// without a network.

/** Krystal's production API host. */
export const KRYSTAL_BASE_URL = 'https://api.krystal.app';

/**
 * The all-zero address, which Cloudflare's WAF in front of api.krystal.app
 * rejects when it appears in a query string. See `assertNoWafTripwire`.
 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface KrystalClientOptions {
  baseUrl?: string;
  /** Per-attempt timeout. Krystal's p99 on lp-txn calls was ~6.5s when sampled. */
  timeoutMs?: number;
  /** Retries for transient failures (5xx, network, timeout). Excludes 429. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. */
  retryBaseDelayMs?: number;
  /**
   * Retries specifically for 429. Deliberately small and separate: a rate limit
   * is a signal to back off globally, not something to grind through.
   */
  maxRateLimitRetries?: number;
  /** Called on every 429 seen, including ones that are subsequently retried. */
  onRateLimit?: (info: RateLimitEvent) => void;
  /** Injectable for tests; defaults to global fetch (Node 22). */
  fetchImpl?: typeof fetch;
}

export interface RateLimitEvent {
  url: string;
  attempt: number;
  retryAfterMs: number | null;
  willRetry: boolean;
}

export class KrystalHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly bodyExcerpt: string;

  constructor(message: string, status: number, url: string, bodyExcerpt: string) {
    super(message);
    this.name = 'KrystalHttpError';
    this.status = status;
    this.url = url;
    this.bodyExcerpt = bodyExcerpt;
  }
}

/**
 * Thrown when Krystal rate-limits us. Separate class so callers can react to it
 * specifically — the poller should widen its interval rather than treat this as
 * a generic failure, and it should be alerted on rather than swallowed.
 */
export class KrystalRateLimitError extends KrystalHttpError {
  readonly retryAfterMs: number | null;
  readonly attempts: number;

  constructor(url: string, bodyExcerpt: string, retryAfterMs: number | null, attempts: number) {
    super(
      `Krystal rate-limited the request after ${attempts} attempt(s)` +
        (retryAfterMs === null ? '' : ` (Retry-After: ${retryAfterMs}ms)`) +
        `: ${url}`,
      429,
      url,
      bodyExcerpt,
    );
    this.name = 'KrystalRateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.attempts = attempts;
  }
}

/**
 * Thrown when Cloudflare (not Krystal) rejects the request. Distinguished from
 * a plain 403 because the remedy is completely different — see
 * `assertNoWafTripwire`.
 */
export class KrystalBlockedError extends KrystalHttpError {
  constructor(url: string, bodyExcerpt: string) {
    super(
      `Cloudflare blocked the request to Krystal (not an API error): ${url}. ` +
        'The most common cause is an all-zero address in the query string.',
      403,
      url,
      bodyExcerpt,
    );
    this.name = 'KrystalBlockedError';
  }
}

export class KrystalTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Krystal request timed out after ${timeoutMs}ms: ${url}`);
    this.name = 'KrystalTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export type QueryValue = string | number | boolean;
export type Query = Record<string, QueryValue | undefined>;

/**
 * Cloudflare in front of api.krystal.app returns a 403 HTML challenge page for
 * ANY request whose query string contains the 40-zero address — verified by
 * bisection: appending `?x=0x0000...0000` to an otherwise-working endpoint
 * (`/all/v1/strategies/supportedProtocols`) flips a 200 into a 403.
 *
 * This bites in practice because `platformWallet` is a natural place to pass
 * the zero address when you do not want to attribute a referral fee. Fail loudly
 * at the call site rather than let it surface as a mystery 403 mid-incident.
 */
export function assertNoWafTripwire(query: Query): void {
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value.toLowerCase().includes(ZERO_ADDRESS)) {
      throw new Error(
        `Krystal query parameter "${key}" contains the all-zero address. ` +
          "Cloudflare's WAF blocks these requests with a 403 HTML page before they reach " +
          'the API. Pass a real address instead (any non-zero EOA works for platformWallet).',
      );
    }
  }
}

export function buildQueryString(query: Query): string {
  assertNoWafTripwire(query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class KrystalClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRateLimitRetries: number;
  private readonly onRateLimit: ((info: RateLimitEvent) => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KrystalClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? KRYSTAL_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 300;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 1;
    this.onRateLimit = options.onRateLimit;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * GET a JSON endpoint. Returns the parsed body as `unknown` on purpose — the
   * caller must run it through a mapper rather than assert a shape it did not
   * verify.
   */
  async getJson(path: string, query: Query = {}): Promise<unknown> {
    const url = `${this.baseUrl}${path}${buildQueryString(query)}`;
    let transientAttempts = 0;
    let rateLimitAttempts = 0;

    for (;;) {
      let response: Response;
      try {
        response = await this.fetchOnce(url);
      } catch (error) {
        if (error instanceof KrystalTimeoutError || isNetworkError(error)) {
          if (transientAttempts < this.maxRetries) {
            await sleep(this.backoffDelay(transientAttempts++));
            continue;
          }
        }
        throw error;
      }

      if (response.status === 429) {
        const body = await readExcerpt(response);
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const willRetry = rateLimitAttempts < this.maxRateLimitRetries;
        this.onRateLimit?.({ url, attempt: rateLimitAttempts + 1, retryAfterMs, willRetry });
        if (!willRetry) {
          throw new KrystalRateLimitError(url, body, retryAfterMs, rateLimitAttempts + 1);
        }
        rateLimitAttempts += 1;
        // Honour Retry-After when present; otherwise back off hard, because a
        // 429 with no hint means we have no idea how much headroom is left.
        await sleep(retryAfterMs ?? this.backoffDelay(this.maxRetries));
        continue;
      }

      if (response.status >= 500) {
        const body = await readExcerpt(response);
        if (transientAttempts < this.maxRetries) {
          await sleep(this.backoffDelay(transientAttempts++));
          continue;
        }
        throw new KrystalHttpError(
          `Krystal returned ${response.status} after ${transientAttempts + 1} attempt(s): ${url}`,
          response.status,
          url,
          body,
        );
      }

      if (!response.ok) {
        const body = await readExcerpt(response);
        // Cloudflare's block page is HTML; a genuine Krystal 4xx is JSON.
        if (response.status === 403 && /<!DOCTYPE html|cf-error-details/i.test(body)) {
          throw new KrystalBlockedError(url, body);
        }
        // 4xx other than 429 is a request bug. Retrying cannot fix it.
        throw new KrystalHttpError(
          `Krystal returned ${response.status}: ${url}`,
          response.status,
          url,
          body,
        );
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new KrystalHttpError(
          `Krystal returned a non-JSON 200 body: ${url}`,
          response.status,
          url,
          text.slice(0, 400),
        );
      }
    }
  }

  private backoffDelay(attempt: number): number {
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    const jitter = Math.random() * this.retryBaseDelayMs;
    return Math.min(exponential + jitter, 30_000);
  }

  private async fetchOnce(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new KrystalTimeoutError(url, this.timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'FetchError');
}

async function readExcerpt(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return '';
  }
}

let sharedClient: KrystalClient | undefined;

/** Process-wide default client, so callers need not thread one through. */
export function getKrystalClient(): KrystalClient {
  sharedClient ??= new KrystalClient();
  return sharedClient;
}

/** Test/bootstrap seam for replacing the shared client. */
export function setKrystalClient(client: KrystalClient | undefined): void {
  sharedClient = client;
}
