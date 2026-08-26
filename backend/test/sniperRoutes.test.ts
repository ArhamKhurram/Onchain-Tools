// Route-level tests for the sniper control plane.
//
// These are the exception to this repo's pure-function-only rule, and the reason
// is that the properties under test are properties of the ROUTING, not of any
// function: that `dryRun:false` in a create body is ignored, that a disarmed
// rule cannot fire live, that the kill switch reaches executeFire, and — the one
// that matters most — that no response body ever contains the venue API token.
// None of those can be proved by calling a function; they need a real request
// going through the real middleware chain.
//
// No supertest dependency is added: the router is mounted on a bare express app
// listening on an ephemeral loopback port, and driven with global fetch. Nothing
// leaves the machine — every fire in here is either a dry run or a refusal
// BEFORE an executor is constructed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

const CONTROL_TOKEN = 'test-control-token-0123456789abcdef';
/** Distinctive on purpose: every response body is scanned for this string. */
const VENUE_SECRET = 'SLOTSHARK-SECRET-DO-NOT-LEAK-9f3a2b';
const ADDRESS = 'So11111111111111111111111111111111111111112';

process.env.OCT_MODE = 'local';
delete process.env.TRENCHCORD_MODE;
delete process.env.OCT_SNIPER_DRY_RUN;
process.env.SNIPER_CONTROL_TOKEN = CONTROL_TOKEN;
process.env.SLOTSHARK_API_TOKEN = VENUE_SECRET;

const { createSniperRouter } = await import('../src/api/sniper/router.js');
const { setSniperRuntime } = await import('../src/sniper/runtime.js');
const { InMemorySniperStore, utcDay } = await import('../src/sniper/store.js');
const { IdempotencyLedger } = await import('../src/sniper/idempotency.js');
const { estimateFees } = await import('../src/sniper/fees.js');

let server: Server;
let base: string;
let store: InstanceType<typeof InMemorySniperStore>;

function newRuntime() {
  store = new InMemorySniperStore();
  setSniperRuntime({ store, ledger: new IdempotencyLedger(), clock: () => Date.now() });
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { 'X-OCT-Sniper-Token': CONTROL_TOKEN },
): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON is a failure the assertions will surface */
  }
  return { status: res.status, body: parsed, text };
}

/** A minimal valid rule body. `sizeTotal` + fees stays well inside every cap. */
function ruleBody(over: Record<string, unknown> = {}) {
  return {
    name: 'test rule',
    chain: 'sol',
    venue: 'slotshark',
    handles: ['elon'],
    interactionTypes: ['tweet'],
    matcher: { op: 'leaf', pattern: { pattern: 'doge', matchMode: 'includes' } },
    phase: 1,
    mint: 'MINT1',
    entryStyle: 'single',
    sizeUnit: 'SOL',
    sizeTotal: 1,
    walletIds: [] as string[],
    perFireCap: 2,
    perTriggerCap: 10,
    slippageBps: 500,
    exec: { kind: 'sol', antimev: true },
    maxTweetAgeMs: 60_000,
    fireWindowMs: 30_000,
    maxAttempts: 3,
    mcapCeiling: null,
    autoDisableAfterFire: false,
    ...over,
  };
}

async function seedWalletAndRule(over: Record<string, unknown> = {}) {
  const w = await call('POST', '/wallets', {
    label: 'main', chain: 'sol', venue: 'slotshark', address: ADDRESS,
    unit: 'SOL', perFireCap: 2, dailyCap: 10, maxOpen: 5,
  });
  expect(w.status).toBe(201);
  const walletId = w.body.wallet.walletId as string;
  const r = await call('POST', '/rules', ruleBody({ walletIds: [walletId], ...over }));
  expect(r.status).toBe(201);
  return { walletId, ruleId: r.body.rule.id as string, rule: r.body.rule };
}

beforeAll(async () => {
  const app = express();
  app.use('/sniper/v1', createSniperRouter());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sniper/v1`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  newRuntime();
  process.env.SLOTSHARK_API_TOKEN = VENUE_SECRET;
  delete process.env.OCT_SNIPER_DRY_RUN;
});

describe('sniper control plane — authentication', () => {
  // The bug this guards: local mode has NO auth (auth/middleware.ts sets
  // userId='local' with no credential) and a wildcard cors(). Without a
  // credential here, any web page the operator visits could author an armed
  // rule with caps of its own choosing.
  it('refuses every route without the control token', async () => {
    for (const [method, path] of [
      ['GET', '/status'], ['GET', '/rules'], ['GET', '/wallets'],
      ['GET', '/fires'], ['GET', '/budget'], ['GET', '/venues'],
    ] as const) {
      const res = await call(method, path, undefined, {});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses a wrong control token', async () => {
    const res = await call('GET', '/status', undefined, { 'X-OCT-Sniper-Token': 'nope' });
    expect(res.status).toBe(401);
  });

  it('refuses a disallowed origin outright, with no CORS headers', async () => {
    const res = await fetch(`${base}/status`, {
      headers: { Origin: 'https://evil.example', 'X-OCT-Sniper-Token': CONTROL_TOKEN },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a disallowed preflight with 403 and no CORS headers', async () => {
    const res = await fetch(`${base}/rules`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });

  // The bug these guard, and it broke every browser deployment: the guard used
  // to answer EVERY OPTIONS with 403 and no Access-Control-* header at all. Its
  // comment assumed a same-origin console, which is true only for the Electron
  // shell. In hosted mode VITE_API_URL must point at Railway while the console
  // is served from Vercel, and in local dev vite serves :5173 against a backend
  // on :3001 — both cross-origin, and sniperApi always sets an Authorization or
  // X-OCT-Sniper-Token header, which forces a preflight. So the browser sent
  // OPTIONS, got a bare 403, and never sent the real request: an empty Sniper
  // tab with no error anywhere. Supertest does not implement CORS, but the
  // status and the response headers are assertable directly, which is all the
  // property needs.
  it('answers an allowed-origin preflight with 204 and the exact origin echoed', async () => {
    const origin = 'http://localhost:5173';
    const res = await fetch(`${base}/rules`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    // The exact origin, never '*'.
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
    const allowedHeaders = res.headers.get('access-control-allow-headers') ?? '';
    for (const h of ['Authorization', 'Content-Type', 'X-OCT-Sniper-Token']) {
      expect(allowedHeaders, h).toContain(h);
    }
    // Without this a shared cache can serve one origin's allow header to another.
    expect((res.headers.get('vary') ?? '').toLowerCase()).toContain('origin');
  });

  // 5174 is the landing dev server, which proxies /dashboard to 5173 — and it is
  // the URL `npm run dev` prints and the README documents. Allowing only 5173
  // left the console's own documented entry point refused whenever VITE_API_URL
  // is set, which is exactly what frontend/.env.example ships.
  it('allows the landing dev server origin the README tells you to open', async () => {
    for (const origin of ['http://localhost:5174', 'http://127.0.0.1:5174']) {
      const res = await fetch(`${base}/session`, { headers: { Origin: origin } });
      expect(res.status, origin).toBe(200);
      expect(res.headers.get('access-control-allow-origin'), origin).toBe(origin);
    }
  });

  // Loopback is necessary and NOT sufficient, and this is the T12 property for
  // this surface: GET /session hands out the per-boot control token, so an
  // origin that gets an allow header can read it and then spend. Another dev
  // server the operator happens to be running on :8080 is loopback too.
  it('refuses a loopback origin that is not the console’s', async () => {
    for (const origin of ['http://localhost:8080', 'http://127.0.0.1:4173']) {
      const res = await fetch(`${base}/session`, { headers: { Origin: origin } });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull();
      expect(await res.text(), origin).not.toContain(CONTROL_TOKEN);
    }
  });

  // Same-origin is proven from the Host header rather than asserted: a browser
  // will not let a page forge either Host or Origin, so equality is real.
  it('allows the console served from this very server (the desktop shell)', async () => {
    const selfOrigin = base.replace('/sniper/v1', '');
    const res = await fetch(`${base}/status`, {
      headers: { Origin: selfOrigin, 'X-OCT-Sniper-Token': CONTROL_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(selfOrigin);
  });

  it('echoes the allow header on the real allowed-origin request too', async () => {
    const origin = 'http://localhost:5173';
    const res = await fetch(`${base}/status`, {
      headers: { Origin: origin, 'X-OCT-Sniper-Token': CONTROL_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  });

  // Deliberate: this plane authenticates on a header it sets itself and on
  // nothing ambient, so a cookie added to this app later must not become a CSRF
  // vector against the one surface that spends.
  it('never sends Access-Control-Allow-Credentials, even to an allowed origin', async () => {
    const origin = 'http://localhost:5173';
    for (const init of [
      { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } },
      { headers: { Origin: origin, 'X-OCT-Sniper-Token': CONTROL_TOKEN } },
    ]) {
      const res = await fetch(`${base}/status`, init);
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('hands the local console its token over GET /session', async () => {
    const res = await call('GET', '/session', undefined, {});
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(CONTROL_TOKEN);
  });
});

describe('sniper control plane — a rule is born disarmed and in dry-run', () => {
  // The bug this guards: a create handler that reads `state`/`dryRun` from the
  // body lets a single POST produce an armed, live rule. The four safety acts
  // (create -> arm -> go live -> fire) collapse into one.
  it('ignores state and dryRun in a create body', async () => {
    const { rule } = await seedWalletAndRule({ state: 'armed', dryRun: false });
    expect(rule.state).toBe('draft');
    expect(rule.dryRun).toBe(true);
  });

  // The bug this guards: an edit form round-tripping a stale `dryRun:false`
  // would take a rule live as a side effect of saving a name change.
  it('ignores state and dryRun in a patch body', async () => {
    const { ruleId } = await seedWalletAndRule();
    const res = await call('PATCH', `/rules/${ruleId}`, { name: 'renamed', state: 'armed', dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.rule.name).toBe('renamed');
    expect(res.body.rule.state).toBe('draft');
    expect(res.body.rule.dryRun).toBe(true);
  });

  it('refuses to arm without the typed confirmation', async () => {
    const { ruleId } = await seedWalletAndRule();
    expect((await call('POST', `/rules/${ruleId}/arm`, {})).status).toBe(400);
    expect((await call('POST', `/rules/${ruleId}/arm`, { confirm: 'ARM' })).status).toBe(200);
  });

  it('refuses to go live without the typed confirmation', async () => {
    const { ruleId } = await seedWalletAndRule();
    expect((await call('POST', `/rules/${ruleId}/dry-run`, { dryRun: false })).status).toBe(400);
    const ok = await call('POST', `/rules/${ruleId}/dry-run`, { dryRun: false, confirm: 'GO_LIVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.rule.dryRun).toBe(false);
  });

  it('refuses to fire without the typed confirmation', async () => {
    const { ruleId } = await seedWalletAndRule();
    expect((await call('POST', `/rules/${ruleId}/fire`, {})).status).toBe(400);
  });

  it('reports the process dry-run flag rather than making the console guess it', async () => {
    expect((await call('GET', '/status')).body.processDryRun).toBe(false);
    process.env.OCT_SNIPER_DRY_RUN = 'true';
    expect((await call('GET', '/status')).body.processDryRun).toBe(true);
    // And no rule may force LIVE against it.
    const { ruleId } = await seedWalletAndRule();
    const res = await call('POST', `/rules/${ruleId}/dry-run`, { dryRun: false, confirm: 'GO_LIVE' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('process_dry_run');
  });
});

describe('sniper control plane — a disarmed rule cannot fire live', () => {
  // The bug this guards: `armed` is the ONLY thing standing between a live
  // rule and a live send in the alpha, because OCT never sees a tweet. If the
  // fire endpoint honoured `state` loosely, disarming would be decorative.
  it('403s a live fire on a rule that is not armed', async () => {
    const { ruleId } = await seedWalletAndRule();
    await call('POST', `/rules/${ruleId}/arm`, { confirm: 'ARM' });
    await call('POST', `/rules/${ruleId}/dry-run`, { dryRun: false, confirm: 'GO_LIVE' });
    await call('POST', `/rules/${ruleId}/disarm`);

    const res = await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('rule_not_armed');
    // Nothing was attempted: no fire row, no budget movement.
    expect((await call('GET', '/fires')).body.fires).toHaveLength(0);
  });

  it('lets a DRAFT rule be rehearsed in dry-run — that is the point of dry-run', async () => {
    const { ruleId } = await seedWalletAndRule();
    const res = await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.outcome).toBe('fired');
    expect(res.body.legs[0].state).toBe('filled');
  });

  // The bug this guards: the fire log could not distinguish a synthetic dry-run
  // fill from a real one, which is the most dangerous ambiguity a money log can
  // carry — a `filled` row with no `dryRun` reads as real spend.
  it('marks a dry-run fill as dryRun in the fire log, against the dryrun venue', async () => {
    const { ruleId } = await seedWalletAndRule();
    await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    const fires = (await call('GET', '/fires')).body.fires;
    expect(fires).toHaveLength(1);
    expect(fires[0].dryRun).toBe(true);
    expect(fires[0].venue).toBe('dryrun');
  });

  it('gives each press a fresh trigger id, so a second test buy is not silently suppressed', async () => {
    const { ruleId } = await seedWalletAndRule();
    const a = await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    const b = await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    expect(a.body.tweetId).not.toBe(b.body.tweetId);
    expect(b.body.outcome).toBe('fired');
  });
});

describe('sniper control plane — the kill switch binds', () => {
  it('aborts a fire while the switch is on, and fires again once resumed', async () => {
    const { ruleId } = await seedWalletAndRule();

    const on = await call('POST', '/kill', { on: true, reason: 'testing' });
    expect(on.status).toBe(200);
    expect(on.body.on).toBe(true);
    expect((await call('GET', '/status')).body.kill.on).toBe(true);

    const blocked = await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    expect(blocked.body.outcome).toBe('aborted');
    expect(blocked.body.reason).toBe('kill_switch');

    // Turning it ON needs no confirmation; turning it OFF does.
    expect((await call('POST', '/kill', { on: false })).status).toBe(400);
    expect((await call('POST', '/kill', { on: false, confirm: 'RESUME' })).status).toBe(200);

    const after = await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    expect(after.body.outcome).toBe('fired');
  });

  it('scopes the kill switch to the calling user, not the process', async () => {
    // Local mode has exactly one user, so this is asserted at the store level:
    // the concrete multi-tenancy gap was a switch keyed on nothing at all.
    await call('POST', '/kill', { on: true });
    expect(await store.isKilled('local')).toBe(true);
    expect(await store.isKilled('someone-else')).toBe(false);
  });
});

describe('sniper control plane — the venue credential never leaves this process', () => {
  // The bug this guards: the Slotshark bearer authorizes /sell and
  // /wallets/withdraw as well as /buy, so a single echo of it in any response
  // body is a total drain of the funded balance.
  it('never appears in any response body', async () => {
    const { ruleId, walletId } = await seedWalletAndRule();
    await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });

    const responses = await Promise.all([
      call('GET', '/status'),
      call('GET', '/venues'),
      call('GET', '/wallets'),
      call('GET', '/rules'),
      call('GET', '/fires'),
      call('GET', '/budget'),
      call('GET', '/session', undefined, {}),
      call('PATCH', `/wallets/${walletId}`, { label: 'renamed' }),
      call('POST', `/rules/${ruleId}/arm`, { confirm: 'ARM' }),
    ]);

    for (const res of responses) {
      expect(res.text).not.toContain(VENUE_SECRET);
      // Not just the whole token — no substring long enough to be useful either.
      expect(res.text).not.toContain(VENUE_SECRET.slice(0, 12));
      expect(res.text.toLowerCase()).not.toContain('slotshark_api_token');
    }
  });

  it('reports connection status without any secret material', async () => {
    const res = await call('GET', '/venues');
    expect(res.status).toBe(200);
    expect(res.body.venues).toHaveLength(1);
    const venue = res.body.venues[0];
    expect(venue.venue).toBe('slotshark');
    expect(venue.connected).toBe(true);
    // The exact key set. A `secret`, `token` or fingerprint key appearing here
    // later would be caught by this assertion rather than by a review.
    expect(Object.keys(venue).sort()).toEqual(
      ['connected', 'label', 'region', 'updatedAt', 'venue', 'walletAddress'],
    );
  });

  // The bug this guards: an error path that says "token was 43 chars, expected
  // 44" leaks the token's shape. `no_credential` must be the WHOLE message.
  it('says only `no_credential` when a live fire has no connected credential', async () => {
    const { ruleId } = await seedWalletAndRule();
    await call('POST', `/rules/${ruleId}/arm`, { confirm: 'ARM' });
    await call('POST', `/rules/${ruleId}/dry-run`, { dryRun: false, confirm: 'GO_LIVE' });
    delete process.env.SLOTSHARK_API_TOKEN;

    const res = await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'no_credential', reason: 'no_credential' });
  });
});

describe('sniper control plane — wallets and budget', () => {
  it('rejects a wallet address that is not base58 solana', async () => {
    const res = await call('POST', '/wallets', {
      label: 'bad', chain: 'sol', venue: 'slotshark', address: 'not-an-address',
      unit: 'SOL', perFireCap: 1, dailyCap: 2, maxOpen: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('invalid_address');
  });

  // The bug this guards: SOL_ADDRESS_REGEX in @oct/shared carries the /g flag,
  // so `.test()` is stateful via lastIndex and ALTERNATE calls on the same valid
  // address return false — every second wallet an operator adds is rejected.
  it('accepts the same valid address twice in a row', async () => {
    const body = {
      label: 'a', chain: 'sol', venue: 'slotshark', address: ADDRESS,
      unit: 'SOL', perFireCap: 1, dailyCap: 2, maxOpen: 1,
    };
    expect((await call('POST', '/wallets', body)).status).toBe(201);
    expect((await call('POST', '/wallets', { ...body, label: 'b' })).status).toBe(201);
  });

  // The bug this guards: a daily cap below one fire's cap refuses every fire
  // after the first, silently, at the reservation.
  it('rejects a daily cap below the per-fire cap', async () => {
    const res = await call('POST', '/wallets', {
      label: 'x', chain: 'sol', venue: 'slotshark', address: ADDRESS,
      unit: 'SOL', perFireCap: 5, dailyCap: 1, maxOpen: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('daily_below_per_fire');
  });

  // The bug this guards: POST /wallets funnels the caps through
  // `positiveNumber`, which is `Number.isFinite(n) && n > 0`. PATCH did not — it
  // took a raw `Number(body.dailyCap)` and leaned on `validateWalletShape`,
  // whose only test was `!(x > 0)`. Infinity passes that, and
  // `dailyCap < perFireCap` is false when dailyCap is Infinity, so a PATCH could
  // raise a wallet's daily cap and max-open to unbounded on a wallet that POST
  // had refused to create that way.
  //
  // JSON has no Infinity literal; `"Infinity"` is a plain string that Number()
  // turns into one, which is how it arrives over the wire.
  it('refuses to patch a wallet cap to a non-finite value', async () => {
    const { walletId } = await seedWalletAndRule();
    for (const patch of [{ dailyCap: 'Infinity' }, { perFireCap: 'Infinity' }, { maxOpen: 'Infinity' }]) {
      const res = await call('PATCH', `/wallets/${walletId}`, patch);
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe('invalid_caps');
    }
    // Unchanged: the refusal must not have written a partial update.
    const after = await call('GET', '/wallets');
    expect(after.body.wallets[0]).toMatchObject({ perFireCap: 2, dailyCap: 10, maxOpen: 5 });
  });

  it('refuses a non-finite cap on rule create', async () => {
    const w = await call('POST', '/wallets', {
      label: 'main', chain: 'sol', venue: 'slotshark', address: ADDRESS,
      unit: 'SOL', perFireCap: 2, dailyCap: 10, maxOpen: 5,
    });
    const walletId = w.body.wallet.walletId as string;
    const res = await call(
      'POST',
      '/rules',
      ruleBody({ walletIds: [walletId], perFireCap: 'Infinity', perTriggerCap: 'Infinity' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('caps_inconsistent');
  });

  it('refuses to delete a wallet a rule still references', async () => {
    const { walletId, ruleId } = await seedWalletAndRule();
    const res = await call('DELETE', `/wallets/${walletId}`);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('wallet_in_use');
    expect(res.body.ruleIds).toEqual([ruleId]);
  });

  // The bug this guards: hiding a wallet that has not fired today makes "no row"
  // look like "no cap" — the operator cannot see the limit they are spending
  // against until they have already spent something.
  it('renders a wallet with no fires today at zero spend rather than omitting it', async () => {
    await seedWalletAndRule();
    const res = await call('GET', '/budget');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].spentToday).toBe(0);
    expect(res.body.rows[0].dailyCap).toBe(10);
  });
});

describe('sniper control plane — arming, editing and unknown legs', () => {
  it('refuses to arm a rule that would abort on every trigger', async () => {
    const { walletId } = await seedWalletAndRule();
    const bad = await call('POST', '/rules', ruleBody({
      walletIds: [walletId], sizeTotal: 8, perFireCap: 9, perTriggerCap: 9,
    }));
    expect(bad.status).toBe(201); // a draft may be saved
    // 8 SOL + 0.5% = 8.04 fits, so make it genuinely unclearable instead.
    const worse = await call('PATCH', `/rules/${bad.body.rule.id}`, { sizeTotal: 9, perFireCap: 9, perTriggerCap: 9 });
    expect(worse.status).toBe(200);
    const res = await call('POST', `/rules/${bad.body.rule.id}/arm`, { confirm: 'ARM' });
    expect(res.status).toBe(422);
    expect(res.body.reason).toBe('size_over_trigger_cap');
  });

  it('refuses to edit or delete an armed rule — disarm first', async () => {
    const { ruleId } = await seedWalletAndRule();
    await call('POST', `/rules/${ruleId}/arm`, { confirm: 'ARM' });
    expect((await call('PATCH', `/rules/${ruleId}`, { name: 'x' })).body.reason).toBe('rule_armed');
    expect((await call('DELETE', `/rules/${ruleId}`)).body.reason).toBe('rule_armed');
    await call('POST', `/rules/${ruleId}/disarm`);
    expect((await call('PATCH', `/rules/${ruleId}`, { name: 'x' })).status).toBe(200);
  });

  it('refuses to resolve a leg that is not an unresolved `unknown`', async () => {
    const { ruleId } = await seedWalletAndRule();
    await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    const fire = (await call('GET', '/fires')).body.fires[0];
    expect(fire.state).toBe('filled');
    const res = await call('POST', `/fires/${fire.id}/resolve`, { resolution: 'not_filled' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('not_unknown');
  });

  // The bug this guards, and it is the one way an authenticated caller could
  // defeat the daily cap: /resolve read `fire.resolution`, then awaited twice
  // before writing, and `releaseLeg` is not idempotent — the SQL's
  // `greatest(0, spent_today - amount)` floors a double release, it does not
  // detect one. So N concurrent resolves of the same fire each passed the read
  // guard and each credited the day back money that was reserved once.
  it('credits the budget exactly once when two resolves of one fire interleave', async () => {
    const { walletId, ruleId, rule } = await seedWalletAndRule();
    const at = Date.now();
    const day = utcDay(at);
    const legTotal = 1 + estimateFees(rule, 1);

    // Two prior legs stay reserved, so the release is MEASURABLE rather than
    // hidden by the floor at zero: one release must land spentToday on 4, a
    // second would take it to 4 - legTotal. `greatest(0, ...)` is exactly why
    // the naive version of this test proves nothing.
    for (const amount of [2, 2, legTotal]) {
      expect(
        (await store.reserveLeg('local', { walletId, chain: 'sol', unit: 'SOL', day, amountWithFees: amount })).ok,
      ).toBe(true);
    }
    const fire = await store.recordFire('local', {
      ruleId, userId: 'local', triggerKey: 'manual:race', walletId, legNo: 0,
      attempts: 1, mint: 'MINT1', amount: 1, state: 'unknown', dryRun: false, venue: 'slotshark', at,
    });

    // Force the interleaving this fix exists for: hold each request at the
    // getFire boundary until BOTH have read the row as unresolved. Left to
    // themselves two loopback requests against an in-memory store serialise, the
    // second is refused at the read, and the window is never entered — so the
    // test would pass against the broken code too.
    let arrived = 0;
    let openGate!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const realGetFire = store.getFire.bind(store);
    store.getFire = async (userId: string, id: string) => {
      const row = await realGetFire(userId, id);
      if (++arrived >= 2) openGate();
      else await bothRead;
      return row;
    };

    const [a, b] = await Promise.all([
      call('POST', `/fires/${fire.id}/resolve`, { resolution: 'not_filled' }),
      call('POST', `/fires/${fire.id}/resolve`, { resolution: 'not_filled' }),
    ]);
    expect(arrived).toBe(2); // both really were inside the window

    // Exactly one winner; the loser is refused, not silently ignored. WHICH
    // refusal depends on the store: InMemorySniperStore hands out live row
    // references, so the loser's read guard sees the winner's write and answers
    // `not_unknown`, while a store that returns snapshots (Supabase) lets it
    // reach the guarded transition and answer `already_resolved`. Both mean the
    // same thing — someone else resolved this — so either is acceptable here.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['already_resolved', 'not_unknown']).toContain(loser.body?.reason);

    // THE assertion. Against the pre-fix code both requests passed the read
    // guard and both released, landing this on 4 - legTotal.
    const snap = (await store.budgetSnapshot('local', walletId, 'sol', day))!;
    expect(snap.spentToday).toBeCloseTo(4, 9);
    expect(snap.openPositions).toBe(2);
  });

  // The same property one layer down, without the HTTP timing: the store's own
  // transition is what has to be idempotent, because it is the thing both the
  // local and the hosted implementation must agree on.
  it('makes a second resolveFire a no-op at the store level', async () => {
    const { walletId, ruleId } = await seedWalletAndRule();
    const at = Date.now();
    const fire = await store.recordFire('local', {
      ruleId, userId: 'local', triggerKey: 'manual:twice', walletId, legNo: 0,
      attempts: 1, mint: 'MINT1', amount: 1, state: 'unknown', dryRun: false, venue: 'slotshark', at,
    });

    expect(await store.resolveFire('local', fire.id, { resolution: 'not_filled', at })).not.toBeNull();
    expect(await store.resolveFire('local', fire.id, { resolution: 'not_filled', at })).toBeNull();
    // And a leg that was never indeterminate cannot be resolved at all.
    const filled = await store.recordFire('local', {
      ruleId, userId: 'local', triggerKey: 'manual:filled', walletId, legNo: 0,
      attempts: 1, mint: 'MINT1', amount: 1, state: 'filled', dryRun: false, venue: 'slotshark', at,
    });
    expect(await store.resolveFire('local', filled.id, { resolution: 'not_filled', at })).toBeNull();
  });
});

describe('sniper control plane — a lowered cap binds today', () => {
  /** Force today's budget row into existence at the wallet's current caps. */
  async function openTodaysBudgetRow(walletId: string): Promise<string> {
    const day = utcDay(Date.now());
    expect((await store.reserveLeg('local', { walletId, chain: 'sol', unit: 'SOL', day, amountWithFees: 1 })).ok).toBe(true);
    return day;
  }

  // The bug this guards: cap snapshotting was symmetric, so once today's budget
  // row existed, LOWERING a cap did nothing until the next UTC day — and that is
  // the operator's most likely risk-reducing action. The console accepted an
  // instruction to spend less and kept spending at the old ceiling.
  it('applies a reduction to today’s already-snapshotted row', async () => {
    const { walletId } = await seedWalletAndRule();
    const day = await openTodaysBudgetRow(walletId);
    expect((await store.budgetSnapshot('local', walletId, 'sol', day))!.dailyCap).toBe(10);

    const res = await call('PATCH', `/wallets/${walletId}`, { perFireCap: 1, dailyCap: 3, maxOpen: 2 });
    expect(res.status).toBe(200);

    const snap = (await store.budgetSnapshot('local', walletId, 'sol', day))!;
    expect(snap.perFireCap).toBe(1);
    expect(snap.dailyCap).toBe(3);
    expect(snap.maxOpen).toBe(2);
  });

  // The other direction stays deferred, and that asymmetry is the point: a raise
  // must not retroactively re-authorise a fire today's budget already refused.
  it('leaves today’s row alone when a cap is raised', async () => {
    const { walletId } = await seedWalletAndRule();
    const day = await openTodaysBudgetRow(walletId);

    const res = await call('PATCH', `/wallets/${walletId}`, { perFireCap: 5, dailyCap: 100, maxOpen: 50 });
    expect(res.status).toBe(200);

    const snap = (await store.budgetSnapshot('local', walletId, 'sol', day))!;
    expect(snap.perFireCap).toBe(2);
    expect(snap.dailyCap).toBe(10);
    expect(snap.maxOpen).toBe(5);
  });

  // Mixed edit: only the columns that went down move.
  it('clamps only the reduced columns', async () => {
    const { walletId } = await seedWalletAndRule();
    const day = await openTodaysBudgetRow(walletId);

    expect((await call('PATCH', `/wallets/${walletId}`, { dailyCap: 4 })).status).toBe(200);

    const snap = (await store.budgetSnapshot('local', walletId, 'sol', day))!;
    expect(snap.dailyCap).toBe(4);
    expect(snap.perFireCap).toBe(2);
    expect(snap.maxOpen).toBe(5);
  });
});

describe('sniper control plane — a rule may only name the caller’s own wallets', () => {
  // The bug this guards is a diagnostics one, but it lands on the operator as a
  // lie: an unowned walletId reached the fire path, runLeg correctly refused the
  // leg with `no_wallet`, and then recordFire's INSERT hit the sniper_fires ->
  // sniper_wallets foreign key, threw out of executeFire, and surfaced through
  // fireRuleNow's catch as `venue_unsupported`. The operator was told the venue
  // was broken when the truth was a wallet that is not theirs.
  it('refuses to create a rule naming a wallet that is not the caller’s', async () => {
    const res = await call('POST', '/rules', ruleBody({ walletIds: ['00000000-0000-4000-8000-000000000000'] }));
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('unknown_wallet');
    expect(res.body.detail).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('refuses to patch a rule onto a wallet that is not the caller’s', async () => {
    const { ruleId } = await seedWalletAndRule();
    const res = await call('PATCH', `/rules/${ruleId}`, { walletIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('unknown_wallet');
  });

  // An EMPTY list still saves: `no_wallets` is an arm-time reason on purpose, so
  // a half-finished draft can be written before its wallets are configured.
  it('still saves a draft with no wallets at all', async () => {
    expect((await call('POST', '/rules', ruleBody({ walletIds: [] }))).status).toBe(201);
  });

  // And the leg-level refusal survives to the operator when a wallet disappears
  // between arming and firing, which is the case the create-time check cannot
  // cover. The fire row carries no wallet reference — the empty string is the
  // domain spelling of the NULL wallet_id the hosted store writes, which is what
  // keeps the FK from rejecting the row.
  it('records a clean no_wallet abort when the wallet vanishes mid-flight', async () => {
    const { ruleId, walletId } = await seedWalletAndRule();
    // Delete behind the rule's back — the route refuses a referenced wallet.
    expect(await store.deleteWallet('local', walletId)).toBe(true);

    const res = await call('POST', `/rules/${ruleId}/fire`, { confirm: 'FIRE' });
    expect(res.status).toBe(200);
    expect(res.body.legs[0].state).toBe('aborted');
    expect(res.body.legs[0].reason).toBe('no_wallet');
    // The LegResult still names the wallet the rule asked for…
    expect(res.body.legs[0].walletId).toBe(walletId);
    // …while the persisted row references none, so the hosted FK holds.
    expect((await store.fireLog('local'))[0].walletId).toBe('');
  });
});
