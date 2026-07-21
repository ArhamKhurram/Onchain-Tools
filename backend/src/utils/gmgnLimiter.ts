/** Serialize GMGN OpenAPI calls to avoid RATE_LIMIT_BANNED from burst traffic. */

const MIN_GAP_MS = 400;
const MAX_CONCURRENT = 2;
const BAN_COOLDOWN_MS = 90_000;

let inFlight = 0;
let lastStartedAt = 0;
let bannedUntil = 0;
const waiters: Array<() => void> = [];

export function markGmgnRateLimited(error: string): void {
  const lower = error.toLowerCase();
  if (lower.includes('rate_limit') || lower.includes('too many')) {
    bannedUntil = Date.now() + BAN_COOLDOWN_MS;
    console.warn(`[GMGN] Rate limited — pausing outbound calls for ${BAN_COOLDOWN_MS / 1000}s`);
  }
}

export function isGmgnRateLimited(): boolean {
  return Date.now() < bannedUntil;
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

async function acquire(): Promise<void> {
  if (isGmgnRateLimited()) {
    const waitMs = bannedUntil - Date.now();
    await new Promise((r) => setTimeout(r, waitMs));
  }

  while (inFlight >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  const gap = MIN_GAP_MS - (Date.now() - lastStartedAt);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));

  inFlight += 1;
  lastStartedAt = Date.now();
}

export async function withGmgnLimit<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Run async tasks one at a time (for multi-wallet / multi-chain fan-out). */
export async function mapSequential<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) {
    out.push(await fn(item));
  }
  return out;
}
