// The sniper control plane: /sniper/v1.
//
// It is a control plane and a record, NOT a trigger engine. In the alpha the
// tweet -> buy loop lives inside Slotshark, configured in the operator's own
// Slotshark account; OCT never sees a tweet and is never told when a Slotshark
// trigger fires (docs/architecture/sniper.md, alpha trigger decision). So every
// cap, the kill switch and the dry-run flag below bind exactly one thing: buys
// fired from this console, through POST /rules/:id/fire. The UI says so in
// words; this comment is why.
//
// SHAPE. `createSniperRouter()` takes no `wsServer` and no `RouterContext`, and
// that is deliberate rather than an oversight: taking either would force it to
// be constructed after the objects it must precede, and mounting after
// `app.use(cors())` is exactly what must not happen. It therefore carries its
// own body parser, its own rate limit and its own auth — see ./auth.ts.
//
// SAFETY SHAPE, in four separate deliberate acts. Create (state:'draft',
// dryRun:true, forced) -> Arm (confirm:'ARM' + full validateRule) -> Go live
// (confirm:'GO_LIVE', a different endpoint) -> Fire (confirm:'FIRE'). No single
// request can traverse more than one of them, and saving a rule can never fire.

import { Router, json, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { isHostedMode } from '../../storage/index.js';
import { processDryRun } from '../../sniper/executors/registry.js';
import { estimateFees } from '../../sniper/fees.js';
import { fireRuleNow } from '../../sniper/fireOrchestrator.js';
import { getSniperRuntime } from '../../sniper/runtime.js';
import { utcDay } from '../../sniper/store.js';
import { validateRule, validateRuleStructure } from '../../sniper/validateRule.js';
import { narrowRegion } from '../../sniper/executors/slotshark.js';
import { getVenueConnection, getVenueSecret } from '../../sniper/venueCredentials.js';
import {
  SlotsharkDashboard,
  VendorAuthError,
  VendorContractError,
  VendorRequestError,
} from '../../sniper/venue/slotsharkDashboard.js';
import type {
  BudgetRow,
  Chain,
  EntryStyle,
  ExecParams,
  InteractionType,
  MatcherNode,
  NormalizedTweet,
  SizeUnit,
  SnipeRule,
  Venue,
  WalletConfig,
} from '../../sniper/types.js';
import { denyCrossOrigin, isLoopbackRequest, requireSniperAuth } from './auth.js';
import { getSniperControlToken } from './controlToken.js';

/**
 * Anchored, LOCAL, and not `SOL_ADDRESS_REGEX` from @oct/shared. That one
 * carries the /g flag (contract.ts:11), and `.test()` on a /g regex is stateful
 * via lastIndex — alternate calls on the same valid address return false, which
 * would reject every second wallet an operator adds.
 */
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,48}$/;

const MAX_FIRE_LIMIT = 500;
const DEFAULT_FIRE_LIMIT = 200;

const CHAINS: Chain[] = ['sol', 'bsc'];
const UNITS: SizeUnit[] = ['SOL', 'BNB', 'USDC'];
const VENUES: Venue[] = ['slotshark', 'dryrun'];
const FUNDABLE_VENUES: Exclude<Venue, 'dryrun'>[] = ['slotshark'];

type Body = Record<string, unknown>;

function userIdOf(req: Request): string {
  // requireSniperAuth has already run and always sets this; the fallback exists
  // so a future route added above the middleware fails as 'local' rather than
  // as `undefined`, which would key a budget on the string "undefined".
  return req.userId ?? 'local';
}

function bad(res: Response, status: number, reason: string, detail?: string): void {
  res.status(status).json({ error: reason, reason, ...(detail ? { detail } : {}) });
}

/**
 * A real, bounded amount. `> 0` alone is NOT that — `Infinity > 0` is true, so
 * a bare `> 0` admits an unbounded cap, and the reservation then reads
 * `spentToday + amountWithFees > dailyCap` as permanently false: the cap is off,
 * not raised. The DB CHECK is not a backstop either, since Infinity never
 * survives JSON serialization to reach it.
 */
function positiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function positiveNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return positiveFinite(n) ? n : null;
}

/**
 * Wallet field validation, shared by POST and PATCH. Uses the SAME refusal
 * strings as the CHECK constraints in the migration, so a local install and a
 * hosted one refuse the same wallet for the same stated reason.
 */
function validateWalletShape(w: WalletConfig): string | null {
  if (!SOL_ADDRESS.test(w.address)) return 'invalid_address';
  // Finiteness matters on this path specifically because PATCH does not go
  // through `positiveNumber` — it takes a raw `Number(body.dailyCap)`, and JSON
  // carries Infinity as the plain string "Infinity". So POST refused what PATCH
  // would then happily write.
  if (!positiveFinite(w.perFireCap) || !positiveFinite(w.dailyCap) || !positiveFinite(w.maxOpen)) {
    return 'invalid_caps';
  }
  // A daily cap below one fire's cap refuses every fire after the first,
  // silently, at the reservation.
  if (w.dailyCap < w.perFireCap) return 'daily_below_per_fire';
  if (w.venue === 'slotshark' && w.chain !== 'sol') return 'venue_chain_mismatch';
  const unitOk =
    (w.chain === 'sol' && (w.unit === 'SOL' || w.unit === 'USDC')) ||
    (w.chain === 'bsc' && (w.unit === 'BNB' || w.unit === 'USDC'));
  if (!unitOk) return 'unit_chain_mismatch';
  return null;
}

// Deliberately NOT validated here: `maxOpen` against the venue's task-account
// count. One durable nonce account carries one in-flight transaction, so a
// wallet with 6 of them cannot execute a 7th concurrent fire — OCT would
// authorize a fire that times out and lands as `unknown`, stranding its
// reservation until someone resolves it by hand.
//
// It is still not checked on this path, because reading the count means calling
// Slotshark, and that would make creating a wallet fail whenever their API is
// down. The check belongs where both numbers are already on screen: the import
// flow surfaces `nonceCount` and warns there. If you are tempted to move it
// here, note that the count also changes whenever the operator deploys more, so
// a value captured at write time is stale by definition.

/**
 * The first walletId in `walletIds` that is not one of this caller's wallets,
 * or null if they all are.
 *
 * Checked on CREATE and PATCH, not only at arm time, and the reason is a
 * diagnostics one rather than a safety one. Nothing cross-tenant can be spent
 * either way — runLeg gets null from store.getWallet and refuses the leg long
 * before a reservation — but the refusal used to be unrecoverable downstream:
 * the fire row it wrote carried a wallet_id with no matching sniper_wallets row,
 * the FK rejected the insert, recordFire threw, and fireRuleNow's catch reported
 * the whole fire as `venue_unsupported`. The operator was told the venue was
 * broken when the truth was a wallet that is not theirs.
 *
 * An EMPTY walletIds list still passes: `no_wallets` is an arm-time reason on
 * purpose, so a half-finished draft can be saved before its wallets exist. What
 * cannot be saved is a rule naming a wallet id that is not the caller's.
 */
async function firstUnownedWalletId(
  store: ReturnType<typeof getSniperRuntime>['store'],
  userId: string,
  walletIds: string[],
): Promise<string | null> {
  if (walletIds.length === 0) return null;
  const owned = new Set((await store.listWallets(userId)).map((w) => w.walletId));
  return walletIds.find((id) => !owned.has(id)) ?? null;
}

/**
 * Build a rule from a request body. `state` and `dryRun` are NOT read from the
 * body at all — they are not validated and then overridden, they are simply
 * never looked at, so no future edit can accidentally start honouring them.
 * They move only through /arm, /disarm and /dry-run.
 */
function ruleFromBody(id: string, userId: string, body: Body, base?: SnipeRule): SnipeRule {
  const pick = <T>(key: string, fallback: T): T => (body[key] === undefined ? fallback : (body[key] as T));

  return {
    id,
    userId,
    name: String(pick('name', base?.name ?? '')).slice(0, 80),
    // Forced, always. See the header: create is one of four separate acts.
    state: base?.state ?? 'draft',
    chain: pick<Chain>('chain', base?.chain ?? 'sol'),
    venue: pick<Venue>('venue', base?.venue ?? 'slotshark'),
    handles: (pick<string[]>('handles', base?.handles ?? []) ?? []).map((h) => String(h).toLowerCase()),
    interactionTypes: pick<InteractionType[]>('interactionTypes', base?.interactionTypes ?? ['tweet']),
    matcher: pick<MatcherNode>('matcher', base?.matcher ?? { op: 'or', children: [] }),
    phase: pick<1 | 2>('phase', base?.phase ?? 1),
    mint: pick<string | null>('mint', base?.mint ?? null),
    entryStyle: pick<EntryStyle>('entryStyle', base?.entryStyle ?? 'single'),
    ladderSplit: pick<number[] | null>('ladderSplit', base?.ladderSplit ?? null),
    sizeUnit: pick<SizeUnit>('sizeUnit', base?.sizeUnit ?? 'SOL'),
    sizeTotal: Number(pick('sizeTotal', base?.sizeTotal ?? 0)),
    walletIds: pick<string[]>('walletIds', base?.walletIds ?? []),
    perFireCap: Number(pick('perFireCap', base?.perFireCap ?? 0)),
    perTriggerCap: Number(pick('perTriggerCap', base?.perTriggerCap ?? 0)),
    slippageBps: Number(pick('slippageBps', base?.slippageBps ?? 500)),
    exec: pick<ExecParams>('exec', base?.exec ?? { kind: 'sol', antimev: true }),
    maxTweetAgeMs: Number(pick('maxTweetAgeMs', base?.maxTweetAgeMs ?? 60_000)),
    fireWindowMs: Number(pick('fireWindowMs', base?.fireWindowMs ?? 30_000)),
    maxAttempts: Number(pick('maxAttempts', base?.maxAttempts ?? 3)),
    mcapCeiling: pick<number | null>('mcapCeiling', base?.mcapCeiling ?? null),
    autoDisableAfterFire: Boolean(pick('autoDisableAfterFire', base?.autoDisableAfterFire ?? true)),
    // Forced true on create; on patch it keeps whatever /dry-run last set.
    dryRun: base?.dryRun ?? true,
  };
}

/**
 * The synthetic tweet a manual fire carries.
 *
 * The uuid is in the TEXT as well as the id ON PURPOSE. `triggerKey` keys on
 * the id, but there is a second guard that hashes the tweet text within a 30s
 * window (idempotency.ts:60-62) — so a constant string would make the
 * operator's second test buy return `{outcome:'suppressed'}` with no reason,
 * indistinguishable from a broken button.
 */
function syntheticTweet(now: number): NormalizedTweet {
  const tweetId = `manual:${randomUUID()}`;
  return {
    tweetId,
    rootTweetId: null,
    handle: 'oct-console',
    interaction: 'tweet',
    text: `manual fire ${tweetId}`,
    createdAt: now,
    firstSeenAt: now,
  };
}

export function createSniperRouter(): Router {
  const router = Router();

  router.use(denyCrossOrigin);
  // Its own parser: the app-wide express.json() is mounted after this router.
  router.use(json({ limit: '32kb' }));

  if (isHostedMode()) {
    // The /api generalLimiter does not cover this prefix. The doc's warning
    // about throttling terminal-state callbacks does not apply — there are no
    // venue callbacks in the alpha.
    router.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
  }

  // -------------------------------------------------------------------------
  // GET /session — LOCAL ONLY. Issues the credential, so it is the one route
  // that cannot sit behind requireSniperAuth.
  //
  // The Origin allowlist is what stops a malicious web page (threat T12); the
  // token is what satisfies T12's stated requirement, and means an Origin-check
  // bug alone is not sufficient to spend money. Against a hostile LOCAL process
  // that can forge headers, neither helps — the control there is the 0600 file
  // mode and the desktop app reading it directly instead of calling this.
  // Hosted mode 404s: the Supabase bearer is the credential there.
  // -------------------------------------------------------------------------
  router.get('/session', (req, res) => {
    if (isHostedMode()) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: 'The sniper control plane is loopback-only in local mode.' });
      return;
    }
    // Never logged, never persisted anywhere but the 0600 file.
    res.json({ token: getSniperControlToken() });
  });

  router.use(requireSniperAuth);

  // -------------------------------------------------------------------------
  // Status — the one call the console's status bar polls.
  // -------------------------------------------------------------------------
  router.get('/status', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store } = getSniperRuntime();
      const [kill, rules, wallets, fires, venue] = await Promise.all([
        store.getKillState(userId),
        store.listRules(userId),
        store.listWallets(userId),
        store.fireLog(userId, MAX_FIRE_LIMIT),
        getVenueConnection(userId, 'slotshark'),
      ]);

      res.json({
        mode: isHostedMode() ? 'hosted' : 'local',
        // Env is unreadable from a browser and mis-reading it is a money bug,
        // so the process flag has to be surfaced rather than inferred.
        processDryRun: processDryRun(),
        // A literal, not a computed value: the UI's honesty about where triggers
        // live is driven by the API rather than by a hardcoded frontend string
        // that could drift when M2 lands.
        triggerSource: 'slotshark_native',
        kill,
        venue,
        counts: {
          rules: rules.length,
          armedRules: rules.filter((r) => r.state === 'armed').length,
          wallets: wallets.length,
          unresolvedUnknown: fires.filter((f) => f.state === 'unknown' && !f.resolution).length,
        },
      });
    } catch (err) {
      bad(res, 500, 'status_failed', (err as Error)?.message);
    }
  });

  // -------------------------------------------------------------------------
  // Kill switch. Turning it ON needs no confirmation — stopping is always safe.
  // Turning it OFF does.
  // -------------------------------------------------------------------------
  router.post('/kill', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const body = (req.body ?? {}) as Body;
      const on = Boolean(body.on);
      if (!on && body.confirm !== 'RESUME') {
        bad(res, 400, 'confirmation_required');
        return;
      }
      const { store } = getSniperRuntime();
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : null;
      await store.setKillSwitch(userId, on, reason);
      res.json(await store.getKillState(userId));
    } catch (err) {
      bad(res, 500, 'kill_failed', (err as Error)?.message);
    }
  });

  // -------------------------------------------------------------------------
  // Venues — READ ONLY, metadata only, and deliberately no POST/DELETE.
  //
  // Hosted connect/disconnect go from the user's own client straight to
  // Supabase (sniper_store_venue_credential / sniper_delete_venue_credential),
  // so the plaintext token never reaches this process. Local connect is editing
  // backend/.env, which the backend must not do to itself.
  //
  // This route must never grow a reveal affordance: `sniper_get_venue_secret`
  // has no `authenticated` grant, so the token is unreadable by its own owner
  // by design, and even a last-4 fingerprint would require this backend to read
  // the secret — the exact thing being avoided.
  // -------------------------------------------------------------------------
  router.get('/venues', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const venues = await Promise.all(FUNDABLE_VENUES.map((v) => getVenueConnection(userId, v)));
      res.json({ venues });
    } catch (err) {
      bad(res, 500, 'venues_failed', (err as Error)?.message);
    }
  });

  /**
   * The wallets that exist AT THE VENUE, for the "import" affordance on the
   * wallet form. Read-only, and deliberately not merged with GET /wallets: one
   * is what OCT governs, the other is what Slotshark holds, and conflating them
   * would imply OCT's caps apply to a wallet it has never been told about.
   *
   * Balances are fetched per wallet (their API has no batch endpoint) and a
   * failed balance degrades that row to `balanceSol: null` rather than failing
   * the list — an unreachable balance should not block importing an address.
   */
  router.get('/venues/:venue/wallets', async (req, res) => {
    const venue = req.params.venue as Venue;
    if (!FUNDABLE_VENUES.includes(venue as Exclude<Venue, 'dryrun'>)) {
      return bad(res, 400, 'invalid_venue');
    }
    try {
      const userId = userIdOf(req);
      // The dashboard API is per-region ("use the region your account is on"),
      // so the connection row is read for its `region` alongside the secret.
      // `narrowRegion` is what keeps that free-text column from reaching a URL.
      const [secret, connection] = await Promise.all([
        getVenueSecret(userId, venue),
        getVenueConnection(userId, venue),
      ]);
      if (!secret) return bad(res, 409, 'no_credential');

      const api = new SlotsharkDashboard({ apiToken: secret, region: narrowRegion(connection.region) });
      const wallets = await api.listWallets();
      const withBalances = await Promise.all(
        wallets.map(async (w) => {
          try {
            const b = await api.walletBalance(w.pubkey);
            return { ...w, balanceSol: b.balanceSol };
          } catch {
            return { ...w, balanceSol: null };
          }
        }),
      );

      // Which of them OCT already governs, so the UI can show "imported"
      // instead of offering a duplicate that would fail the unique constraint.
      const known = new Set(
        (await getSniperRuntime().store.listWallets(userId))
          .filter((w) => w.venue === venue)
          .map((w) => w.address),
      );
      res.json({
        wallets: withBalances.map((w) => ({ ...w, imported: known.has(w.pubkey) })),
      });
    } catch (err) {
      if (err instanceof VendorAuthError) return bad(res, 502, 'venue_rejected_credential');
      if (err instanceof VendorContractError) return bad(res, 502, 'venue_contract_changed', err.message);
      if (err instanceof VendorRequestError) return bad(res, 502, 'venue_unreachable', err.message);
      bad(res, 500, 'venue_wallets_failed', (err as Error)?.message);
    }
  });

  // -------------------------------------------------------------------------
  // Wallets
  // -------------------------------------------------------------------------
  router.get('/wallets', async (req, res) => {
    try {
      // `address` is returned: it is a public on-chain address, not a secret.
      res.json({ wallets: await getSniperRuntime().store.listWallets(userIdOf(req)) });
    } catch (err) {
      bad(res, 500, 'wallets_failed', (err as Error)?.message);
    }
  });

  router.post('/wallets', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const body = (req.body ?? {}) as Body;

      const chain = body.chain as Chain;
      const venue = body.venue as Exclude<Venue, 'dryrun'>;
      const unit = body.unit as SizeUnit;
      if (!CHAINS.includes(chain)) return bad(res, 400, 'invalid_chain');
      if (!FUNDABLE_VENUES.includes(venue)) return bad(res, 400, 'invalid_venue');
      if (!UNITS.includes(unit)) return bad(res, 400, 'invalid_unit');

      const perFireCap = positiveNumber(body.perFireCap);
      const dailyCap = positiveNumber(body.dailyCap);
      const maxOpen = positiveNumber(body.maxOpen);
      if (perFireCap === null || dailyCap === null || maxOpen === null) return bad(res, 400, 'invalid_caps');

      const wallet: WalletConfig = {
        walletId: randomUUID(),
        label: String(body.label ?? '').slice(0, 80),
        venue,
        address: String(body.address ?? ''),
        chain,
        unit,
        perFireCap,
        dailyCap,
        maxOpen: Math.floor(maxOpen),
      };

      const problem = validateWalletShape(wallet);
      if (problem) return bad(res, 400, problem);

      await getSniperRuntime().store.putWallet(userId, wallet);
      res.status(201).json({ wallet });
    } catch (err) {
      bad(res, 500, 'wallet_create_failed', (err as Error)?.message);
    }
  });

  router.patch('/wallets/:id', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store, clock } = getSniperRuntime();
      const existing = await store.getWallet(userId, req.params.id);
      if (!existing) return bad(res, 404, 'not_found');

      const body = (req.body ?? {}) as Body;
      // `chain` and `venue` are IMMUTABLE. Changing either orphans the wallet's
      // existing budget rows, which are keyed (wallet_id, chain, day) — the
      // day's spend would silently reset to zero.
      const next: WalletConfig = {
        ...existing,
        label: body.label === undefined ? existing.label : String(body.label).slice(0, 80),
        address: body.address === undefined ? existing.address : String(body.address),
        unit: body.unit === undefined ? existing.unit : (body.unit as SizeUnit),
        perFireCap: body.perFireCap === undefined ? existing.perFireCap : Number(body.perFireCap),
        dailyCap: body.dailyCap === undefined ? existing.dailyCap : Number(body.dailyCap),
        maxOpen: body.maxOpen === undefined ? existing.maxOpen : Math.floor(Number(body.maxOpen)),
      };
      if (!UNITS.includes(next.unit)) return bad(res, 400, 'invalid_unit');

      const problem = validateWalletShape(next);
      if (problem) return bad(res, 400, problem);

      await store.putWallet(userId, next);

      // Caps are snapshotted into the day's budget row when it is created, so a
      // RAISE deliberately does not reach today — a fire already refused stays
      // refused. A REDUCTION is not symmetric with that and must not be treated
      // as if it were: it can only refuse fires that have not happened yet, it
      // is the operator's most likely risk-reducing action, and leaving it inert
      // until the next UTC day means the console accepted an instruction to
      // spend less and kept spending at the old ceiling. So a reduction binds
      // now, monotonically (clampBudgetCaps never raises anything).
      const lowered =
        next.perFireCap < existing.perFireCap ||
        next.dailyCap < existing.dailyCap ||
        next.maxOpen < existing.maxOpen;
      if (lowered) {
        await store.clampBudgetCaps(userId, {
          walletId: next.walletId,
          chain: next.chain,
          day: utcDay(clock()),
          perFireCap: next.perFireCap,
          dailyCap: next.dailyCap,
          maxOpen: next.maxOpen,
        });
      }

      res.json({ wallet: next });
    } catch (err) {
      bad(res, 500, 'wallet_update_failed', (err as Error)?.message);
    }
  });

  router.delete('/wallets/:id', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store } = getSniperRuntime();
      const rules = await store.listRules(userId);
      const referencing = rules.filter((r) => r.walletIds.includes(req.params.id));
      if (referencing.length > 0) {
        res.status(409).json({
          error: 'wallet_in_use',
          reason: 'wallet_in_use',
          ruleIds: referencing.map((r) => r.id),
        });
        return;
      }
      const removed = await store.deleteWallet(userId, req.params.id);
      if (!removed) return bad(res, 404, 'not_found');
      // Budget rows cascade with the wallet; fire rows deliberately survive with
      // a null wallet_id — the record of money moved outlives the wallet.
      res.status(204).end();
    } catch (err) {
      bad(res, 500, 'wallet_delete_failed', (err as Error)?.message);
    }
  });

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------
  router.get('/rules', async (req, res) => {
    try {
      const rules = await getSniperRuntime().store.listRules(userIdOf(req));
      res.json({ rules });
    } catch (err) {
      bad(res, 500, 'rules_failed', (err as Error)?.message);
    }
  });

  router.post('/rules', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store } = getSniperRuntime();
      const body = (req.body ?? {}) as Body;

      // SAFETY-CRITICAL: `state` and `dryRun` are never read from `body` — see
      // ruleFromBody. The row is always written state:'draft', dryRun:true.
      const rule = ruleFromBody(randomUUID(), userId, body);
      if (!rule.name.trim()) return bad(res, 400, 'invalid_name');
      if (!VENUES.includes(rule.venue)) return bad(res, 400, 'invalid_venue');
      if (!CHAINS.includes(rule.chain)) return bad(res, 400, 'invalid_chain');
      if (!UNITS.includes(rule.sizeUnit)) return bad(res, 400, 'invalid_unit');

      // Only the STRUCTURAL half here. The unit/chain agreement between a rule
      // and its wallets stays arm-time, so a draft can be saved before its
      // wallets are configured. Nothing fires either way.
      const check = validateRuleStructure(rule);
      if (!check.ok) return bad(res, 400, check.reason, check.detail);

      // OWNERSHIP is not deferrable, though — see firstUnownedWalletId.
      const unowned = await firstUnownedWalletId(store, userId, rule.walletIds);
      if (unowned) return bad(res, 400, 'unknown_wallet', unowned);

      await store.putRule(userId, rule);
      res.status(201).json({ rule });
    } catch (err) {
      bad(res, 500, 'rule_create_failed', (err as Error)?.message);
    }
  });

  router.patch('/rules/:id', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store } = getSniperRuntime();
      const existing = await store.getRule(userId, req.params.id);
      if (!existing) return bad(res, 404, 'not_found');

      // Editing caps on a LIVE rule is a two-step act: disarm, then edit. A
      // patch that landed mid-fire would change the caps the in-flight loop is
      // reading.
      if (existing.state === 'armed') {
        return bad(res, 409, 'rule_armed');
      }

      // SAFETY-CRITICAL: `state` and `dryRun` in the body are ignored (they are
      // not in ruleFromBody's read set), so an edit form round-tripping a stale
      // `dryRun:false` can never take a rule live. This is structural, not
      // remembered.
      const next = ruleFromBody(existing.id, userId, (req.body ?? {}) as Body, existing);
      const check = validateRuleStructure(next);
      if (!check.ok) return bad(res, 400, check.reason, check.detail);

      const unowned = await firstUnownedWalletId(store, userId, next.walletIds);
      if (unowned) return bad(res, 400, 'unknown_wallet', unowned);

      await store.putRule(userId, next);
      res.json({ rule: next });
    } catch (err) {
      bad(res, 500, 'rule_update_failed', (err as Error)?.message);
    }
  });

  router.delete('/rules/:id', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store } = getSniperRuntime();
      const existing = await store.getRule(userId, req.params.id);
      if (!existing) return bad(res, 404, 'not_found');
      if (existing.state === 'armed') return bad(res, 409, 'rule_armed');
      await store.deleteRule(userId, req.params.id);
      // Fire history survives — the fire row's rule_id nulls out.
      res.status(204).end();
    } catch (err) {
      bad(res, 500, 'rule_delete_failed', (err as Error)?.message);
    }
  });

  // Arm. In the alpha `armed` means precisely one thing: this rule may be fired
  // LIVE by the manual fire endpoint. That is the SAME meaning it will have when
  // M2 lands, so nothing drifts — and it must never be shown as "OCT is watching".
  router.post('/rules/:id/arm', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store } = getSniperRuntime();
      if ((req.body as Body | undefined)?.confirm !== 'ARM') {
        bad(res, 400, 'confirmation required');
        return;
      }
      const rule = await store.getRule(userId, req.params.id);
      if (!rule) return bad(res, 404, 'not_found');

      const check = validateRule(rule, await store.listWallets(userId));
      if (!check.ok) {
        res.status(422).json({ error: check.reason, reason: check.reason, ...(check.detail ? { detail: check.detail } : {}) });
        return;
      }

      await store.setRuleState(userId, rule.id, 'armed');
      res.json({ rule: await store.getRule(userId, rule.id) });
    } catch (err) {
      bad(res, 500, 'rule_arm_failed', (err as Error)?.message);
    }
  });

  // Disarm. Always allowed, never confirmed — same principle as the kill switch:
  // stopping is safe, so nothing may stand between an operator and stopping.
  router.post('/rules/:id/disarm', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store } = getSniperRuntime();
      const rule = await store.getRule(userId, req.params.id);
      if (!rule) return bad(res, 404, 'not_found');
      await store.setRuleState(userId, rule.id, 'disabled');
      res.json({ rule: await store.getRule(userId, rule.id) });
    } catch (err) {
      bad(res, 500, 'rule_disarm_failed', (err as Error)?.message);
    }
  });

  // Going live is its own confirmed call, distinct from arming and from editing.
  router.post('/rules/:id/dry-run', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store } = getSniperRuntime();
      const body = (req.body ?? {}) as Body;
      const rule = await store.getRule(userId, req.params.id);
      if (!rule) return bad(res, 404, 'not_found');

      const dryRun = Boolean(body.dryRun);
      if (!dryRun) {
        if (body.confirm !== 'GO_LIVE') return bad(res, 400, 'confirmation_required');
        if (processDryRun()) {
          // Not a block on the flag so much as the truth: the process flag wins
          // regardless (registry.ts:37-39) and there is deliberately no way for
          // a rule to force LIVE against it. Telling the operator beats letting
          // them set a flag that does nothing.
          return bad(res, 409, 'process_dry_run');
        }
      }

      await store.setRuleDryRun(userId, rule.id, dryRun);
      res.json({ rule: await store.getRule(userId, rule.id) });
    } catch (err) {
      bad(res, 500, 'rule_dry_run_failed', (err as Error)?.message);
    }
  });

  // -------------------------------------------------------------------------
  // THE ONE LIVE executeFire PATH: a manual test buy.
  // -------------------------------------------------------------------------
  router.post('/rules/:id/fire', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store, clock } = getSniperRuntime();
      const body = (req.body ?? {}) as Body;
      if (body.confirm !== 'FIRE') return bad(res, 400, 'confirmation_required');

      const rule = await store.getRule(userId, req.params.id);
      if (!rule) return bad(res, 404, 'not_found');

      const dryRun = processDryRun() || rule.dryRun;
      // A LIVE fire requires an armed rule; a dry-run fire works from any state,
      // so a draft can be rehearsed before it is ever armed.
      if (!dryRun && rule.state !== 'armed') {
        res.status(403).json({ error: 'rule_not_armed', reason: 'rule_not_armed' });
        return;
      }

      const tweet = syntheticTweet(clock());
      const result = await fireRuleNow({ userId, rule, tweet });

      // Preflight refusals map to 409. `no_credential` is the WHOLE message —
      // no length, no prefix, nothing derived from the token.
      if (
        result.legs.length === 0 &&
        (result.reason === 'no_credential' ||
          result.reason === 'venue_unsupported' ||
          result.reason === 'no_wallet_address')
      ) {
        res.status(409).json({ error: result.reason, reason: result.reason });
        return;
      }

      res.json({ ...result, tweetId: tweet.tweetId, dryRun });
    } catch (err) {
      bad(res, 500, 'fire_failed', (err as Error)?.message);
    }
  });

  // -------------------------------------------------------------------------
  // Fire log
  // -------------------------------------------------------------------------
  router.get('/fires', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const requested = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Math.max(1, Math.min(MAX_FIRE_LIMIT, Number.isFinite(requested) ? requested : DEFAULT_FIRE_LIMIT));
      const all = await getSniperRuntime().store.fireLog(userId, MAX_FIRE_LIMIT);

      // Counted over the whole (capped) log, not the filtered page: the banner
      // says how many legs are holding a reservation, and that number must not
      // change because someone filtered the table.
      const unresolvedUnknown = all.filter((f) => f.state === 'unknown' && !f.resolution).length;

      const stateFilter = typeof req.query.state === 'string' ? req.query.state : null;
      const fires = (stateFilter ? all.filter((f) => f.state === stateFilter) : all).slice(0, limit);
      res.json({ fires, unresolvedUnknown });
    } catch (err) {
      bad(res, 500, 'fires_failed', (err as Error)?.message);
    }
  });

  // The human stand-in for reconcile(wallet, mint, since), which cannot be built
  // because no Slotshark fill-history endpoint is known to this repo — see
  // sniper/reconcile.ts.
  router.post('/fires/:id/resolve', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store, clock } = getSniperRuntime();
      const body = (req.body ?? {}) as Body;
      const resolution = body.resolution;
      if (resolution !== 'filled' && resolution !== 'not_filled') return bad(res, 400, 'invalid_resolution');

      const fire = await store.getFire(userId, req.params.id);
      if (!fire) return bad(res, 404, 'not_found');
      // 409 unless the row is genuinely indeterminate and unresolved. Resolving
      // anything else would let a UI bug reverse a real debit. These two reads
      // exist to give the operator the RIGHT refusal; they are not the guard —
      // there are awaits between them and the write, so on their own N
      // concurrent resolves would all pass and each credit the budget back.
      if (fire.state !== 'unknown') return bad(res, 409, 'not_unknown');
      if (fire.resolution) return bad(res, 409, 'already_resolved');

      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : undefined;

      // THE guard: a conditional transition that only matches a still-unresolved
      // `unknown` row. It runs BEFORE the release, and the release runs only if
      // it matched, because releaseLeg is not idempotent — `greatest(0, ...)`
      // floors a double release at zero, it does not detect one, so a second
      // credit hands the day back money that was reserved once.
      //
      // Ordering cost, accepted deliberately: a crash between the two leaves the
      // reservation held against a leg the operator called dead. That is the
      // same direction the fee note below is wrong in — the day ends up MORE
      // constrained than it should be, never less.
      const updated = await store.resolveFire(userId, fire.id, { resolution, at: clock(), note });
      if (!updated) return bad(res, 409, 'already_resolved');

      if (resolution === 'not_filled') {
        // Safe here for one specific reason, and only this reason: the operator
        // has looked at the venue and asserted the send did not land. That is
        // the assertion executeFire cannot make for itself, which is exactly why
        // it holds an `unknown` reservation instead of releasing it.
        const rule = await store.getRule(userId, fire.ruleId);
        const chain: Chain = rule?.chain ?? 'sol';
        // Release exactly what was reserved: amount PLUS the fees that were
        // added to it. Releasing the bare amount would leave the fee portion
        // debited against the day forever.
        //
        // A deleted rule leaves `fees` at 0, so the release under-returns by the
        // fee. That is the deliberate direction to be wrong in — it leaves the
        // day slightly MORE constrained than it should be, never less.
        const fees = rule ? estimateFees(rule, fire.amount) : 0;
        await store.releaseLeg(userId, {
          walletId: fire.walletId,
          chain,
          day: utcDay(fire.at),
          amountWithFees: fire.amount + fees,
          closePosition: true,
        });
      }

      res.json({ fire: updated });
    } catch (err) {
      bad(res, 500, 'resolve_failed', (err as Error)?.message);
    }
  });

  // -------------------------------------------------------------------------
  // Budget — read-only.
  // -------------------------------------------------------------------------
  router.get('/budget', async (req, res) => {
    try {
      const userId = userIdOf(req);
      const { store, clock } = getSniperRuntime();
      const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
        ? req.query.day
        : utcDay(clock());

      const [rows, wallets] = await Promise.all([store.listBudget(userId, day), store.listWallets(userId)]);
      const byWallet = new Map(rows.map((r) => [r.walletId, r]));

      // A wallet with no fires today has no row yet. Synthesize it from the
      // wallet's configured caps rather than omitting it, so "no row" can never
      // read as "no cap".
      const out: BudgetRow[] = wallets.map(
        (w) =>
          byWallet.get(w.walletId) ?? {
            walletId: w.walletId,
            chain: w.chain,
            unit: w.unit,
            day,
            perFireCap: w.perFireCap,
            dailyCap: w.dailyCap,
            maxOpen: w.maxOpen,
            spentToday: 0,
            openPositions: 0,
          },
      );

      res.json({ day, rows: out });
    } catch (err) {
      bad(res, 500, 'budget_failed', (err as Error)?.message);
    }
  });

  return router;
}
