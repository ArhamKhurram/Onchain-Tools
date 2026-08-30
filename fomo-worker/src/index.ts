import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import {
  FomoBrowserClient,
  credentialsFromEnv,
  resolveProfileDir,
} from './client.js';
import { loadPersistedRefreshToken } from './store.js';
import {
  initialWatchdogState,
  noteRequest,
  noteSuccess,
  shouldExitForHang,
} from './watchdog.js';
import type { WorkerStatus } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../.env'), override: false });

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const SECRET = process.env.FOMO_WORKER_SECRET?.trim();
const startedAt = Date.now();

// Hang watchdog (see watchdog.ts for the incident that motivated it).
// FOMO_WORKER_WATCHDOG_MIN tunes the stall threshold in minutes; 0 disables.
const WATCHDOG_CHECK_INTERVAL_MS = 60_000;
const WATCHDOG_THRESHOLD_MS = (() => {
  const raw = Number(process.env.FOMO_WORKER_WATCHDOG_MIN);
  if (Number.isFinite(raw) && raw >= 0) return raw * 60_000;
  return 5 * 60_000;
})();

let watchdogState = initialWatchdogState();

if (!SECRET) {
  console.error('[FomoWorker] FOMO_WORKER_SECRET is required.');
  process.exit(1);
}

let client: FomoBrowserClient | null = null;
let refreshTokenSource: WorkerStatus['refreshTokenSource'] = 'none';
let bootstrapError: string | null = null;

async function resolveRefreshToken(): Promise<string | null> {
  const persisted = await loadPersistedRefreshToken();
  if (persisted) {
    refreshTokenSource = 'supabase';
    return persisted;
  }
  const envToken = process.env.FOMO_REFRESH_TOKEN?.trim();
  if (envToken) {
    refreshTokenSource = 'env';
    return envToken;
  }
  refreshTokenSource = 'none';
  return null;
}

async function ensureClient(): Promise<FomoBrowserClient> {
  if (client) return client;

  const refreshToken = await resolveRefreshToken();
  if (!refreshToken) {
    throw new Error('No FOMO refresh token in Supabase or FOMO_REFRESH_TOKEN env.');
  }

  client = new FomoBrowserClient(credentialsFromEnv(refreshToken), resolveProfileDir());
  await client.init();
  bootstrapError = null;
  return client;
}

function buildStatus(): WorkerStatus {
  return {
    ok: !bootstrapError,
    browserReady: !!client?.browserReady,
    jwtReady: !!client?.jwtReady,
    profileDir: resolveProfileDir(),
    lastCallAt: client?.lastCallAt?.toISOString() ?? null,
    lastCallPath: client?.lastCallPath ?? null,
    lastError: client?.lastError ?? bootstrapError,
    refreshTokenSource,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    pageAgeSec: client?.pageAgeSec ?? null,
    callsSincePageOpen: client?.callsSincePageOpen ?? 0,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    breaker: client?.breaker,
  };
}

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json(buildStatus());
});

// Wedge-state probe: no Playwright work in the handler, safe to curl even when
// the browser is hung. `browserConnected` is a flag check, not an RPC.
app.get('/healthz', (_req, res) => {
  res.json({
    lastRequestAt: watchdogState.lastRequestAt ? new Date(watchdogState.lastRequestAt).toISOString() : null,
    lastSuccessAt: watchdogState.lastSuccessAt ? new Date(watchdogState.lastSuccessAt).toISOString() : null,
    browserConnected: client?.browserConnected ?? false,
  });
});

app.use('/v1', authMiddleware);

app.post('/v1/init', async (_req, res) => {
  try {
    await ensureClient();
    res.json({ ok: true, status: buildStatus() });
  } catch (err) {
    bootstrapError = (err as Error)?.message ?? String(err);
    console.error('[FomoWorker] init failed:', bootstrapError);
    res.status(503).json({ error: bootstrapError, status: buildStatus() });
  }
});

app.post('/v1/session/sync', async (req, res) => {
  const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken is required.' });
    return;
  }

  try {
    if (!client) {
      client = new FomoBrowserClient(credentialsFromEnv(refreshToken), resolveProfileDir());
    } else {
      client.setRefreshToken(refreshToken);
    }
    await client.init();
    bootstrapError = null;
    res.json({ ok: true, status: buildStatus() });
  } catch (err) {
    bootstrapError = (err as Error)?.message ?? String(err);
    res.status(503).json({ error: bootstrapError, status: buildStatus() });
  }
});

app.post('/v1/call', async (req, res) => {
  const apiPath = typeof req.body?.path === 'string' ? req.body.path : '';
  if (!apiPath.startsWith('/')) {
    res.status(400).json({ error: 'path must start with /' });
    return;
  }

  const method = typeof req.body?.method === 'string' ? req.body.method.toUpperCase() : 'GET';
  const body = typeof req.body?.body === 'string' ? req.body.body : req.body?.body ?? null;

  watchdogState = noteRequest(watchdogState, Date.now());

  try {
    const active = await ensureClient();
    const result = await active.call(apiPath, { method, body });
    // The browser round-trip completed — the worker is alive. Upstream HTTP
    // status is irrelevant here; a 404 from fomo.family still proves health.
    watchdogState = noteSuccess(watchdogState, Date.now());
    res.json(result);
  } catch (err) {
    bootstrapError = (err as Error)?.message ?? String(err);
    res.status(502).json({ error: bootstrapError, status: buildStatus() });
  }
});

app.get('/v1/status', (_req, res) => {
  res.json(buildStatus());
});

async function boot(): Promise<void> {
  try {
    await ensureClient();
    console.log('[FomoWorker] Browser warm and JWT ready.');
  } catch (err) {
    bootstrapError = (err as Error)?.message ?? String(err);
    console.error('[FomoWorker] Bootstrap failed (will retry on first request):', bootstrapError);
  }

  app.listen(PORT, HOST, () => {
    console.log(`[FomoWorker] Listening on http://${HOST}:${PORT}`);
    console.log(`[FomoWorker] Profile dir: ${resolveProfileDir()}`);
  });

  startWatchdog();
}

// Self-watchdog: systemd's Restart=always only fires on exit, and a hang never
// exits — the 2026-08-11 wedge served 45s timeouts for 18 hours while systemd
// considered the unit healthy. If /v1/call traffic keeps arriving but nothing
// completes for WATCHDOG_THRESHOLD_MS, exit(1) and let systemd bring us back
// clean (~15s). Quiet periods never trip it (see shouldExitForHang).
function startWatchdog(): void {
  if (WATCHDOG_THRESHOLD_MS <= 0) {
    console.log('[FomoWorker] Watchdog disabled (FOMO_WORKER_WATCHDOG_MIN=0).');
    return;
  }
  console.log(`[FomoWorker] Watchdog armed: exit if calls stall for ${WATCHDOG_THRESHOLD_MS / 60_000}min.`);
  const timer = setInterval(() => {
    if (!shouldExitForHang(watchdogState, Date.now(), WATCHDOG_THRESHOLD_MS)) return;
    console.error(
      '[FomoWorker] WATCHDOG: /v1/call requests are arriving but none has completed for ' +
        `${WATCHDOG_THRESHOLD_MS / 60_000}min — exiting so systemd restarts us. State: ` +
        JSON.stringify({
          lastRequestAt: watchdogState.lastRequestAt ? new Date(watchdogState.lastRequestAt).toISOString() : null,
          lastSuccessAt: watchdogState.lastSuccessAt ? new Date(watchdogState.lastSuccessAt).toISOString() : null,
          stalledSinceAt: watchdogState.stalledSinceAt ? new Date(watchdogState.stalledSinceAt).toISOString() : null,
          browserConnected: client?.browserConnected ?? false,
          status: buildStatus(),
        }),
    );
    // process.exit is immediate — a hung page.evaluate cannot block it.
    process.exit(1);
  }, WATCHDOG_CHECK_INTERVAL_MS);
  // Don't let the watchdog keep an otherwise-finished process alive.
  timer.unref();
}

void boot();

process.on('SIGTERM', async () => {
  console.log('[FomoWorker] Shutting down...');
  await client?.close();
  process.exit(0);
});
