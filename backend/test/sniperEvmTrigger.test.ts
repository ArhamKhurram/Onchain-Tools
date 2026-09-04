import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EVM_RULE_ID,
  EVM_WALLET_ID,
  buildEvmRule,
  buildEvmWallet,
  createProcessTelegramEvmTrigger,
  createTelegramEvmTrigger,
  ensureEvmWallet,
  extractEvmTokens,
  isTriggerChat,
  toTokenTrigger,
} from '../src/sniper/triggers/telegramChannel';
import { readEvmSniperConfig } from '../src/sniper/evm/config';
import { executeFire } from '../src/sniper/executeFire';
import { IdempotencyLedger } from '../src/sniper/idempotency';
import { InMemorySniperStore, utcDay } from '../src/sniper/store';
import { ExecutorRegistry } from '../src/sniper/executors/registry';
import { DryRunExecutor } from '../src/sniper/executors/dryRun';
import { validateRule } from '../src/sniper/validateRule';
import type { TelegramRawMessage } from '../src/telegram/types';
import type { Chain, Executor, FireLeg, SendOutcome, Venue } from '../src/sniper/types';
import type { FireRuleNowParams } from '../src/sniper/fireOrchestrator';
import type { FireResult } from '../src/sniper/executeFire';

const U = 'local';
const CHAT = '-1001234567890';
const OTHER_CHAT = '-1009999999999';
const TOKEN_A = '0x79fe86b963255ce884bdcac6388c50a599ba277f';
const TOKEN_B = '0x45c83b37c5baf4dad26f3845c28295e2de010962';
const T0 = 1_785_000_000_000; // fixed instant

const cfg = (over: Record<string, string> = {}) =>
  readEvmSniperConfig({ SNIPER_EVM_TRIGGER_CHAT_IDS: CHAT, ...over });

function msg(over: Partial<TelegramRawMessage> = {}): TelegramRawMessage {
  return {
    id: 1,
    chatId: CHAT,
    chatTitle: 'Cipher EVM Algorithm',
    chatType: 'channel',
    text: `New call: ${TOKEN_A}`,
    sender: { id: 'u', username: 'cipher', firstName: 'Cipher', lastName: null, isBot: false },
    timestamp: new Date(T0).toISOString(),
    ...over,
  } as TelegramRawMessage;
}

/** Registered under the real venue so fires take the LIVE accounting path. */
class StubEvmExecutor implements Executor {
  readonly venue: Venue = 'evm_uniswap';
  readonly chains: readonly Chain[] = ['rhc'];
  sent: FireLeg[] = [];
  constructor(private outcome?: () => SendOutcome) {}
  async send(_i: unknown, leg: FireLeg, correlationId: string): Promise<SendOutcome> {
    this.sent.push(leg);
    return this.outcome?.() ?? { kind: 'filled', signature: `0x${correlationId}`, amountIn: leg.amount, amountOut: 0, feePaid: 0 };
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------

describe('the allowlist gates which chat may spend', () => {
  it('matches an armed chat and nothing else', () => {
    const allow = new Set([CHAT]);
    expect(isTriggerChat(CHAT, allow)).toBe(true);
    expect(isTriggerChat(OTHER_CHAT, allow)).toBe(false);
  });

  it('an EMPTY allowlist matches nothing — fail closed', () => {
    expect(isTriggerChat(CHAT, new Set())).toBe(false);
  });

  it('returns null (no listener at all) when no trigger chats are configured', () => {
    const listener = createTelegramEvmTrigger({
      userId: U,
      config: readEvmSniperConfig({}),
      store: new InMemorySniperStore(),
    });
    // Null, not a no-op: there is then nothing to register on the emitter, so
    // there is no path from a Telegram message to this module.
    expect(listener).toBeNull();
  });
});

describe('the listener fires only for allowlisted chats', () => {
  async function harness(over: Record<string, string> = {}) {
    const fired: FireRuleNowParams[] = [];
    const store = new InMemorySniperStore();
    const listener = createTelegramEvmTrigger({
      userId: U,
      config: cfg(over),
      store,
      now: () => T0,
      fire: async (p) => {
        fired.push(p);
        return { outcome: 'fired', legs: [], ruleDisabled: false } satisfies FireResult;
      },
    })!;
    return { listener, fired, store };
  }

  it('fires for the armed chat', async () => {
    const { listener, fired } = await harness();
    await listener(msg());
    expect(fired).toHaveLength(1);
    expect(fired[0].rule.mint).toBe(TOKEN_A);
    expect(fired[0].rule.venue).toBe('evm_uniswap');
    expect(fired[0].rule.chain).toBe('rhc');
  });

  it('IGNORES a chat that is not on the allowlist', async () => {
    const { listener, fired } = await harness();
    await listener(msg({ chatId: OTHER_CHAT }));
    expect(fired).toHaveLength(0);
  });

  it('ignores an armed chat posting no EVM address', async () => {
    const { listener, fired } = await harness();
    await listener(msg({ text: 'gm, no calls yet' }));
    expect(fired).toHaveLength(0);
  });

  it('ignores a SOLANA mint — this executor speaks Robinhood Chain only', async () => {
    const { listener, fired } = await harness();
    await listener(msg({ text: 'So11111111111111111111111111111111111111112 looks good' }));
    expect(fired).toHaveLength(0);
  });

  it('fires once per distinct address in a multi-address post, in posted order', async () => {
    const { listener, fired } = await harness();
    await listener(msg({ text: `${TOKEN_A} and also ${TOKEN_B}` }));
    expect(fired.map((f) => f.rule.mint)).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('fires once when the same address is repeated inside one post', async () => {
    const { listener, fired } = await harness();
    await listener(msg({ text: `${TOKEN_A} ${TOKEN_A} ${TOKEN_A.toUpperCase().replace('0X', '0x')}` }));
    expect(fired).toHaveLength(1);
  });

  it('sizes the fire from the env, not from a hardcoded default', async () => {
    const { listener, fired } = await harness({ SNIPER_EVM_BUY_ETH: '0.03' });
    await listener(msg());
    expect(fired[0].rule.sizeTotal).toBe(0.03);
    expect(fired[0].rule.sizeUnit).toBe('ETH');
  });
});

describe('extractEvmTokens', () => {
  it('lowercases, so the same address in two casings is one token', () => {
    expect(extractEvmTokens(`${TOKEN_A.toUpperCase().replace('0X', '0x')}`)).toEqual([TOKEN_A]);
  });
  it('returns nothing for empty or address-free text', () => {
    expect(extractEvmTokens('')).toEqual([]);
    expect(extractEvmTokens('just chatting')).toEqual([]);
  });
});

describe('the synthetic trigger is identified by the TOKEN, not by the message', () => {
  it('puts the address in both fields the ledger keys on', () => {
    const t = toTokenTrigger(TOKEN_A, T0);
    expect(t.rootTweetId).toBe(TOKEN_A);
    expect(t.tweetId).toBe(TOKEN_A);
    // `text` too: the content guard hashes it, and using the message text would
    // make two addresses in one post hash identically.
    expect(t.text).toBe(TOKEN_A);
  });

  it('two addresses from one message produce two DISTINCT claims', () => {
    const ledger = new IdempotencyLedger();
    expect(ledger.claim(EVM_RULE_ID, toTokenTrigger(TOKEN_A, T0), T0)).toBe(true);
    expect(ledger.claim(EVM_RULE_ID, toTokenTrigger(TOKEN_B, T0), T0)).toBe(true);
  });

  it('the SAME address twice is claimed once', () => {
    const ledger = new IdempotencyLedger();
    expect(ledger.claim(EVM_RULE_ID, toTokenTrigger(TOKEN_A, T0), T0)).toBe(true);
    expect(ledger.claim(EVM_RULE_ID, toTokenTrigger(TOKEN_A, T0), T0 + 60_000)).toBe(false);
  });
});

describe('the synthetic rule is a valid, armable rule', () => {
  it('passes the same structural validation the console enforces', async () => {
    const c = cfg();
    const rule = buildEvmRule(U, TOKEN_A, c);
    const wallet = buildEvmWallet(c, rule.perFireCap);
    expect(validateRule(rule, [wallet])).toEqual({ ok: true });
  });

  it('sets caps that its own leg can actually clear', () => {
    // A cap computed even one float ULP low aborts every fire with
    // `per_fire_cap`, which looks exactly like a working cap doing its job.
    const rule = buildEvmRule(U, TOKEN_A, cfg());
    expect(rule.perFireCap).toBeGreaterThan(rule.sizeTotal);
    expect(rule.perTriggerCap).toBeGreaterThanOrEqual(rule.perFireCap);
  });

  it('does NOT auto-disable — the daily cap is what stops this trigger', () => {
    expect(buildEvmRule(U, TOKEN_A, cfg()).autoDisableAfterFire).toBe(false);
  });

  it('carries EVM exec params, matching its chain', () => {
    expect(buildEvmRule(U, TOKEN_A, cfg()).exec.kind).toBe('evm');
  });
});

describe('the wallet row carries the daily cap', () => {
  it('writes SNIPER_EVM_DAILY_CAP_ETH onto the budget wallet', async () => {
    const store = new InMemorySniperStore();
    const c = cfg({ SNIPER_EVM_DAILY_CAP_ETH: '0.25' });
    await ensureEvmWallet(store, U, c, utcDay(T0));
    const w = await store.getWallet(U, EVM_WALLET_ID);
    expect(w).toMatchObject({ dailyCap: 0.25, chain: 'rhc', unit: 'ETH', venue: 'evm_uniswap' });
  });

  it('sizes maxOpen so it can never bind before the daily cap does', () => {
    const c = cfg();
    const rule = buildEvmRule(U, TOKEN_A, c);
    const w = buildEvmWallet(c, rule.perFireCap);
    expect(w.maxOpen * rule.perFireCap).toBeGreaterThan(c.dailyCapEth);
  });

  it('re-syncing LOWERS a live day\'s cap but never raises it', async () => {
    const store = new InMemorySniperStore();
    await ensureEvmWallet(store, U, cfg({ SNIPER_EVM_DAILY_CAP_ETH: '0.5' }), utcDay(T0));
    // Materialise today's budget row at the high cap.
    await store.reserveLeg(U, { walletId: EVM_WALLET_ID, chain: 'rhc', unit: 'ETH', day: utcDay(T0), amountWithFees: 0.001 });
    expect((await store.budgetSnapshot(U, EVM_WALLET_ID, 'rhc', utcDay(T0)))!.dailyCap).toBe(0.5);

    await ensureEvmWallet(store, U, cfg({ SNIPER_EVM_DAILY_CAP_ETH: '0.1' }), utcDay(T0));
    expect((await store.budgetSnapshot(U, EVM_WALLET_ID, 'rhc', utcDay(T0)))!.dailyCap).toBe(0.1);

    // …and raising it back does nothing today. Snapshotted caps are
    // monotonic-down on purpose: a mid-day raise must not retroactively
    // re-authorise a fire that was already refused.
    await ensureEvmWallet(store, U, cfg({ SNIPER_EVM_DAILY_CAP_ETH: '0.9' }), utcDay(T0));
    expect((await store.budgetSnapshot(U, EVM_WALLET_ID, 'rhc', utcDay(T0)))!.dailyCap).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// The daily cap, driven through the REAL executeFire.
// ---------------------------------------------------------------------------

describe('the daily cap, enforced by executeFire', () => {
  /** Fire `token` through the real risk gate at the injected instant. */
  async function fireOnce(
    ctx: { store: InMemorySniperStore; ledger: IdempotencyLedger; registry: ExecutorRegistry; now: () => number },
    token: string,
    c = cfg(),
  ) {
    await ensureEvmWallet(ctx.store, U, c, utcDay(ctx.now()));
    return executeFire(buildEvmRule(U, token, c), toTokenTrigger(token, ctx.now()), {
      store: ctx.store,
      ledger: ctx.ledger,
      registry: ctx.registry,
      clock: ctx.now,
    });
  }

  function ctx(now: () => number) {
    const registry = new ExecutorRegistry(new DryRunExecutor());
    const executor = new StubEvmExecutor();
    registry.register(executor);
    return { store: new InMemorySniperStore(), ledger: new IdempotencyLedger(), registry, now, executor };
  }

  /** Distinct addresses so idempotency never masks a cap result. */
  const token = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

  it('ALLOWS fires while the day is under the cap', async () => {
    const c = ctx(() => T0);
    const r = await fireOnce(c, token(1));
    expect(r.outcome).toBe('fired');
    expect(r.legs[0].state).toBe('filled');
    const snap = (await c.store.budgetSnapshot(U, EVM_WALLET_ID, 'rhc', utcDay(T0)))!;
    expect(snap.spentToday).toBeCloseTo(0.0101, 10); // 0.01 + the 1% gas buffer
  });

  it('BLOCKS the fire that would cross the cap, and every one after it', async () => {
    const c = ctx(() => T0);
    // 0.1 ETH/day at 0.0101 per fire = nine fires, then refusal.
    const states: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const r = await fireOnce(c, token(i));
      states.push(r.legs[0]?.state ?? r.outcome);
    }
    expect(states.slice(0, 9)).toEqual(Array(9).fill('filled'));
    expect(states.slice(9)).toEqual(Array(3).fill('aborted'));

    const r = await fireOnce(c, token(99));
    expect(r.legs[0]).toMatchObject({ state: 'aborted', reason: 'daily_cap' });
  });

  it('never spends more than the cap in a day, however many tokens are posted', async () => {
    const c = ctx(() => T0);
    for (let i = 1; i <= 40; i++) await fireOnce(c, token(i));
    const snap = (await c.store.budgetSnapshot(U, EVM_WALLET_ID, 'rhc', utcDay(T0)))!;
    // The channel scans ~234 tokens/day; uncapped this would attempt ~2.34 ETH.
    expect(snap.spentToday).toBeLessThanOrEqual(snap.dailyCap);
    expect(snap.spentToday).toBeLessThanOrEqual(0.1);
  });

  it('RESETS across the UTC day boundary (injected clock)', async () => {
    let now = T0;
    const c = ctx(() => now);
    for (let i = 1; i <= 12; i++) await fireOnce(c, token(i));
    expect((await fireOnce(c, token(50))).legs[0]).toMatchObject({ reason: 'daily_cap' });

    // Move to the next UTC day. A new budget row is created from the wallet
    // config, so the allowance is whole again.
    now = T0 + 24 * 60 * 60 * 1000;
    expect(utcDay(now)).not.toBe(utcDay(T0));
    const r = await fireOnce(c, token(51));
    expect(r.legs[0].state).toBe('filled');

    // Yesterday's row is untouched history.
    const yesterday = (await c.store.budgetSnapshot(U, EVM_WALLET_ID, 'rhc', utcDay(T0)))!;
    expect(yesterday.spentToday).toBeLessThanOrEqual(0.1);
  });

  it('honours a LOWER operator cap, and the fee buffer counts toward it', async () => {
    // 0.02 ETH/day at 0.0101 per fire (0.01 + the 1% gas buffer) is ONE fire:
    // two would be 0.0202, over the cap. Reserving the buy amount alone would
    // have let a second through and made the cap soft by exactly the gas bill.
    const c = ctx(() => T0);
    const low = cfg({ SNIPER_EVM_DAILY_CAP_ETH: '0.02' });
    expect((await fireOnce(c, token(1), low)).legs[0].state).toBe('filled');
    expect((await fireOnce(c, token(2), low)).legs[0]).toMatchObject({ reason: 'daily_cap' });

    // A cap that fits two fires does fit two.
    const c2 = ctx(() => T0);
    const mid = cfg({ SNIPER_EVM_DAILY_CAP_ETH: '0.025' });
    expect((await fireOnce(c2, token(1), mid)).legs[0].state).toBe('filled');
    expect((await fireOnce(c2, token(2), mid)).legs[0].state).toBe('filled');
    expect((await fireOnce(c2, token(3), mid)).legs[0]).toMatchObject({ reason: 'daily_cap' });
  });

  it('a garbage cap env falls back to 0.1 ETH/day — never to unlimited', async () => {
    const c = ctx(() => T0);
    const junk = cfg({ SNIPER_EVM_DAILY_CAP_ETH: 'unlimited' });
    for (let i = 1; i <= 12; i++) await fireOnce(c, token(i), junk);
    const snap = (await c.store.budgetSnapshot(U, EVM_WALLET_ID, 'rhc', utcDay(T0)))!;
    expect(snap.dailyCap).toBe(0.1);
    expect(snap.spentToday).toBeLessThanOrEqual(0.1);
  });

  it('respects the per-fire size: each fire debits exactly one buy plus its buffer', async () => {
    const c = ctx(() => T0);
    const sized = cfg({ SNIPER_EVM_BUY_ETH: '0.02', SNIPER_EVM_DAILY_CAP_ETH: '0.5' });
    await fireOnce(c, token(1), sized);
    expect(c.executor.sent).toHaveLength(1);
    expect(c.executor.sent[0].amount).toBe(0.02);
    const snap = (await c.store.budgetSnapshot(U, EVM_WALLET_ID, 'rhc', utcDay(T0)))!;
    expect(snap.spentToday).toBeCloseTo(0.0202, 10);
  });

  it('the SAME address twice results in ONE fire', async () => {
    const c = ctx(() => T0);
    const first = await fireOnce(c, TOKEN_A);
    const second = await fireOnce(c, TOKEN_A);
    expect(first.outcome).toBe('fired');
    // Suppressed by the idempotency claim, before any external call.
    expect(second.outcome).toBe('suppressed');
    expect(c.executor.sent).toHaveLength(1);
  });

  it('the kill switch stops the trigger dead', async () => {
    const c = ctx(() => T0);
    await c.store.setKillSwitch(U, true, 'operator');
    const r = await fireOnce(c, TOKEN_A);
    expect(r).toMatchObject({ outcome: 'aborted', reason: 'kill_switch' });
    expect(c.executor.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('createProcessTelegramEvmTrigger — the self-gating factory', () => {
  const deps = (over: Partial<{ hosted: boolean; env: Record<string, string> }> = {}) => ({
    hosted: over.hosted ?? false,
    config: readEvmSniperConfig({ SNIPER_EVM_TRIGGER_CHAT_IDS: CHAT, ...(over.env ?? {}) }),
    store: new InMemorySniperStore(),
  });

  it('arms in local mode with chat ids set', () => {
    expect(createProcessTelegramEvmTrigger(U, deps())).toBeTypeOf('function');
  });

  it('REFUSES to arm in hosted mode — a process-wide key cannot be scoped to a tenant', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createProcessTelegramEvmTrigger(U, deps({ hosted: true }))).toBeNull();
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('HOSTED mode');
  });

  it('does not arm without chat ids, even in local mode', () => {
    expect(
      createProcessTelegramEvmTrigger(U, {
        hosted: false,
        config: readEvmSniperConfig({}),
        store: new InMemorySniperStore(),
      }),
    ).toBeNull();
  });

  it('ARMS without a signing key — the keyless path is a rehearsal, not a different path', () => {
    // Routing and both gates run; the refusal happens at the signature.
    expect(createProcessTelegramEvmTrigger(U, deps())).toBeTypeOf('function');
  });
});
