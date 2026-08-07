import { describe, it, expect } from 'vitest';
import { executeFire } from '../src/sniper/executeFire';
import { IdempotencyLedger } from '../src/sniper/idempotency';
import { InMemorySniperStore } from '../src/sniper/store';
import { ExecutorRegistry } from '../src/sniper/executors/registry';
import { DryRunExecutor } from '../src/sniper/executors/dryRun';
import type { DryRunOptions } from '../src/sniper/executors/dryRun';
import type { Chain, Executor, FireLeg, SnipeRule, NormalizedTweet, SendOutcome, Venue } from '../src/sniper/types';

/**
 * A stand-in for SlotsharkExecutor: registered under the real `slotshark` venue
 * so a rule with `dryRun:false` takes the LIVE accounting path (no dry-run
 * release), while still touching no network and no money. That is what keeps
 * the budget-arithmetic tests below about arithmetic.
 */
class StubLiveExecutor implements Executor {
  readonly venue: Venue = 'slotshark';
  readonly chains: readonly Chain[] = ['sol'];
  constructor(private outcome?: () => SendOutcome) {}
  async send(_i: unknown, leg: FireLeg, correlationId: string): Promise<SendOutcome> {
    return (
      this.outcome?.() ?? {
        kind: 'filled',
        signature: `LIVE-${correlationId}`,
        amountIn: leg.amount,
        amountOut: leg.amount,
        feePaid: 0,
      }
    );
  }
}

const NOW = 1_785_000_000_000;
const DAY = new Date(NOW).toISOString().slice(0, 10);
const U = 'u1';
const ADDRESS = 'So11111111111111111111111111111111111111112';

function rule(over: Partial<SnipeRule> = {}): SnipeRule {
  return {
    id: 'r1', userId: U, name: 'test', state: 'armed', chain: 'sol', venue: 'dryrun',
    handles: ['elon'], interactionTypes: ['tweet'], matcher: { op: 'leaf', pattern: { pattern: 'doge', matchMode: 'includes' } },
    phase: 1, mint: 'MINT1', entryStyle: 'single', ladderSplit: null,
    sizeUnit: 'SOL', sizeTotal: 1, walletIds: ['w1'], perFireCap: 5, perTriggerCap: 100,
    slippageBps: 500, exec: { kind: 'sol', antimev: true }, maxTweetAgeMs: 60_000,
    fireWindowMs: 30_000, maxAttempts: 3, mcapCeiling: null, autoDisableAfterFire: true, dryRun: false,
    ...over,
  };
}

const tweet: NormalizedTweet = {
  tweetId: 't1', rootTweetId: null, handle: 'elon', interaction: 'tweet',
  text: 'doge to the moon', createdAt: NOW, firstSeenAt: NOW,
};

async function harness(opts: {
  wallets?: { walletId: string; perFireCap?: number; dailyCap?: number; maxOpen?: number; unit?: 'SOL' | 'BNB' | 'USDC' }[];
  dryRunOpts?: DryRunOptions;
  clock?: () => number;
  pushedMcap?: (mint: string) => number | undefined;
}) {
  const store = new InMemorySniperStore();
  for (const w of opts.wallets ?? [{ walletId: 'w1' }]) {
    await store.putWallet(U, {
      walletId: w.walletId, label: w.walletId, venue: 'slotshark', address: ADDRESS,
      chain: 'sol', unit: w.unit ?? 'SOL',
      perFireCap: w.perFireCap ?? 5, dailyCap: w.dailyCap ?? 100, maxOpen: w.maxOpen ?? 5,
    });
  }
  const registry = new ExecutorRegistry(new DryRunExecutor(opts.dryRunOpts));
  registry.register(new StubLiveExecutor());
  return {
    store,
    ledger: new IdempotencyLedger(),
    registry,
    clock: opts.clock ?? (() => NOW),
    pushedMcap: opts.pushedMcap,
  };
}

describe('executeFire — happy path (dry run)', () => {
  it('fires one leg, fills, and auto-disables the rule', async () => {
    const deps = await harness({});
    const r = rule();
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.outcome).toBe('fired');
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0].state).toBe('filled');
    expect(res.legs[0].signature).toMatch(/^DRYRUN-/);
    expect(res.ruleDisabled).toBe(true);
    expect((await deps.store.getRule(U, 'r1'))!.state).toBe('disabled');
  });
});

describe('executeFire — idempotency', () => {
  it('suppresses a duplicate delivery of the same trigger', async () => {
    const deps = await harness({});
    const r = rule({ autoDisableAfterFire: false });
    await deps.store.putRule(U, r);
    const first = await executeFire(r, tweet, deps);
    const second = await executeFire(r, tweet, deps);
    expect(first.outcome).toBe('fired');
    expect(second.outcome).toBe('suppressed');
    // Exactly one fill recorded.
    expect((await deps.store.fireLog(U)).filter((f) => f.state === 'filled')).toHaveLength(1);
  });
});

describe('executeFire — caps bind (M4)', () => {
  it('ladder of 5 legs each at perFireCap spends perTriggerCap, not 5x', async () => {
    // Each leg is 1 SOL (sizeTotal 5, split evenly ×5 → 1 each). perTriggerCap 6
    // (5 SOL + fees) allows it; 5.5 would not.
    const deps = await harness({ wallets: [{ walletId: 'w1', perFireCap: 2, dailyCap: 100 }] });
    const r = rule({
      entryStyle: 'ladder', ladderSplit: [0.2, 0.2, 0.2, 0.2, 0.2], sizeTotal: 5,
      perFireCap: 2, perTriggerCap: 6,
      // Live accounting (via the stub executor) so the dry-run release does not
      // zero out the budget this test is asserting on.
      venue: 'slotshark', dryRun: false,
    });
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.outcome).toBe('fired');
    expect(res.legs).toHaveLength(5);
    expect(res.legs.every((l) => l.state === 'filled')).toBe(true);
    const snap = (await deps.store.budgetSnapshot(U, 'w1', 'sol', DAY))!;
    // 5 legs × (1 + 0.5% fee) = 5.025 spent — bounded, not 25.
    expect(snap.spentToday).toBeCloseTo(5.025, 3);
  });

  it('aborts the whole trigger when perTriggerCap is exceeded, before any send', async () => {
    const deps = await harness({ wallets: [{ walletId: 'w1', perFireCap: 100 }] });
    const r = rule({ sizeTotal: 10, perTriggerCap: 5 }); // 10 + fees > 5
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.outcome).toBe('aborted');
    expect(res.reason).toBe('per_trigger_cap');
    expect(await deps.store.fireLog(U)).toHaveLength(0); // nothing sent
  });

  it('multi-wallet fan-out is N fires against N budgets, one trigger', async () => {
    const deps = await harness({ wallets: [{ walletId: 'w1' }, { walletId: 'w2' }] });
    const r = rule({ walletIds: ['w1', 'w2'], sizeTotal: 1, perTriggerCap: 100, venue: 'slotshark', dryRun: false });
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs).toHaveLength(2);
    expect((await deps.store.budgetSnapshot(U, 'w1', 'sol', DAY))!.openPositions).toBe(1);
    expect((await deps.store.budgetSnapshot(U, 'w2', 'sol', DAY))!.openPositions).toBe(1);
  });
});

describe('executeFire — abort and expire', () => {
  it('aborts on the kill switch before firing', async () => {
    const deps = await harness({});
    const r = rule();
    await deps.store.putRule(U, r);
    await deps.store.setKillSwitch(U, true, null);
    const res = await executeFire(r, tweet, deps);
    expect(res.outcome).toBe('aborted');
    expect(res.reason).toBe('kill_switch');
  });

  it('aborts a leg when a pushed market cap exceeds the ceiling', async () => {
    const deps = await harness({ pushedMcap: () => 2_000_000 });
    const r = rule({ mcapCeiling: 1_000_000 });
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('aborted');
    expect(res.legs[0].reason).toBe('mcap_ceiling');
  });

  it('expires a leg once the fire window is exhausted', async () => {
    // Clock advances past fireWindowMs while the executor keeps returning dead.
    let t = NOW;
    const dead: SendOutcome = { kind: 'dead', reason: 'network', status: 0 };
    const deps = await harness({
      dryRunOpts: { outcomeFor: () => dead },
      clock: () => (t += 20_000), // each read jumps 20s; fireWindowMs is 30s
    });
    const r = rule({ fireWindowMs: 30_000, maxAttempts: 10 });
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('expired');
  });

  it('retries a provably-dead send, then fills', async () => {
    let calls = 0;
    const deps = await harness({
      dryRunOpts: {
        outcomeFor: () => {
          calls++;
          return calls < 2
            ? { kind: 'dead', reason: 'rate_limit', status: 429 }
            : { kind: 'filled', signature: 'OK', amountIn: 1, amountOut: 1, feePaid: 0 };
        },
      },
    });
    const r = rule();
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('filled');
    expect(res.legs[0].attempts).toBe(2);
  });
});

describe('executeFire — indeterminate outcome is never retried', () => {
  it('holds the reservation on unknown and does not re-send', async () => {
    let calls = 0;
    const deps = await harness({
      dryRunOpts: { outcomeFor: () => { calls++; return { kind: 'unknown' }; } },
    });
    const r = rule();
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('unknown');
    expect(calls).toBe(1); // exactly one send — a timeout that landed must not double-buy
    // Reservation held (not released) — and held even though this was a dry run,
    // because `unknown` means the send MAY have landed.
    expect((await deps.store.budgetSnapshot(U, 'w1', 'sol', DAY))!.openPositions).toBe(1);
  });
});

describe('executeFire — a dry-run fill releases its reservation, a live fill does not', () => {
  // The bug this guards: a dry run takes the reservation for real (so the risk
  // gate is genuinely exercised) but no balance poll will ever show a synthetic
  // position closing. Without the release, the 11th test buy against a 10 SOL
  // cap silently returned `daily_cap` and looked exactly like a broken UI.
  it('20 dry-run fires do not exhaust a 10 SOL daily cap', async () => {
    const deps = await harness({ wallets: [{ walletId: 'w1', perFireCap: 5, dailyCap: 10, maxOpen: 2 }] });
    for (let i = 0; i < 20; i++) {
      const r = rule({ id: `r${i}`, dryRun: true, autoDisableAfterFire: false, sizeTotal: 1 });
      await deps.store.putRule(U, r);
      const res = await executeFire(
        r,
        { ...tweet, tweetId: `t${i}`, text: `doge ${i}` },
        deps,
      );
      expect(res.legs[0].state).toBe('filled');
    }
    const snap = (await deps.store.budgetSnapshot(U, 'w1', 'sol', DAY))!;
    expect(snap.spentToday).toBe(0);
    expect(snap.openPositions).toBe(0);
  });

  it('a live fill leaves amount + fees debited', async () => {
    const deps = await harness({ wallets: [{ walletId: 'w1', perFireCap: 5, dailyCap: 10 }] });
    const r = rule({ venue: 'slotshark', dryRun: false, sizeTotal: 1, autoDisableAfterFire: false });
    await deps.store.putRule(U, r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('filled');
    const snap = (await deps.store.budgetSnapshot(U, 'w1', 'sol', DAY))!;
    expect(snap.spentToday).toBeCloseTo(1.005, 6); // 1 SOL + 0.5% venue fee
    expect(snap.openPositions).toBe(1);
  });
});

