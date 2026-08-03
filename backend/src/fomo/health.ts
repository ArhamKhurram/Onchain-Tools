// In-memory FOMO upstream health signals, surfaced by GET /api/fomo/status.
//
// Every FOMO upstream round-trip (in-process Playwright or VPS worker proxy)
// reports here, so prod incidents are diagnosable from the status endpoint
// without SSH-ing into the worker or tailing Railway logs. Counters reset on
// process restart — this is observability, not durable telemetry.

export interface FomoUpstreamError {
  at: string;
  /** What issued the call — an API path (`/v2/leaderboard`) or `worker-transport`. */
  source: string;
  /** Upstream HTTP status; null when the request never produced one. */
  status: number | null;
  message: string;
  cloudflare: boolean;
}

export interface FomoUpstreamHealth {
  lastSuccessAt: string | null;
  lastError: FomoUpstreamError | null;
  /** Last error that looked like Cloudflare interference (challenge/block/status 0). */
  lastCloudflareError: FomoUpstreamError | null;
  successCount: number;
  errorCount: number;
}

const state: FomoUpstreamHealth = {
  lastSuccessAt: null,
  lastError: null,
  lastCloudflareError: null,
  successCount: 0,
  errorCount: 0,
};

/**
 * Does this failure look like Cloudflare got in the way, rather than the FOMO
 * API itself erroring? Status 0 means the in-page fetch threw before getting a
 * response — the canonical signature of a challenge interstitial blocking the
 * request. Otherwise look for Cloudflare page markers in the body.
 */
export function isCloudflareShaped(status: number | null | undefined, body: string | null | undefined): boolean {
  if (!status) return true;
  const text = (body ?? '').slice(0, 4000).toLowerCase();
  if (!text) return false;
  return (
    text.includes('just a moment') ||
    text.includes('attention required') ||
    text.includes('challenge-platform') ||
    text.includes('cf-chl') ||
    // Cloudflare-branded error pages (e.g. "fomo.family | 502: Bad gateway")
    // mention cloudflare in the footer; the API's own JSON errors never do.
    text.includes('cloudflare')
  );
}

export function recordFomoUpstreamSuccess(): void {
  state.lastSuccessAt = new Date().toISOString();
  state.successCount += 1;
}

export function recordFomoUpstreamError(
  source: string,
  status: number | null | undefined,
  message: string,
  body?: string | null,
): void {
  const record: FomoUpstreamError = {
    at: new Date().toISOString(),
    source,
    status: status ?? null,
    message: message.slice(0, 500),
    cloudflare: isCloudflareShaped(status, body ?? message),
  };
  state.lastError = record;
  if (record.cloudflare) state.lastCloudflareError = record;
  state.errorCount += 1;
}

export function getFomoUpstreamHealth(): FomoUpstreamHealth {
  return { ...state };
}

/** Test hook — the module-level state otherwise leaks between specs. */
export function resetFomoUpstreamHealth(): void {
  state.lastSuccessAt = null;
  state.lastError = null;
  state.lastCloudflareError = null;
  state.successCount = 0;
  state.errorCount = 0;
}
