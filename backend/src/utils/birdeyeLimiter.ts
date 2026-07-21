/** Throttle Birdeye wallet API calls (5 rps / 75 rpm across wallet products). */

const MIN_GAP_MS = 300;
const MAX_CONCURRENT = 1;
const BAN_COOLDOWN_MS = 60_000;

let inFlight = 0;
let lastStartedAt = 0;
let bannedUntil = 0;
const waiters: Array<() => void> = [];

export function markBirdeyeRateLimited(error: string): void {
  const lower = error.toLowerCase();
  if (lower.includes('too many') || lower.includes('rate limit')) {
    bannedUntil = Date.now() + BAN_COOLDOWN_MS;
    console.warn(`[Birdeye] Rate limited — pausing outbound calls for ${BAN_COOLDOWN_MS / 1000}s`);
  }
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = waiters.shift();
  if (next) next();
}

async function acquire(): Promise<void> {
  if (Date.now() < bannedUntil) {
    await new Promise((r) => setTimeout(r, bannedUntil - Date.now()));
  }

  while (inFlight >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  const gap = MIN_GAP_MS - (Date.now() - lastStartedAt);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));

  inFlight += 1;
  lastStartedAt = Date.now();
}

export async function withBirdeyeLimit<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
