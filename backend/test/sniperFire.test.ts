import { describe, it, expect } from 'vitest';
import { executeFire } from '../src/sniper/executeFire';
import { IdempotencyLedger } from '../src/sniper/idempotency';
import { InMemorySniperStore } from '../src/sniper/store';
import { ExecutorRegistry } from '../src/sniper/executors/registry';
import { DryRunExecutor } from '../src/sniper/executors/dryRun';
import type { DryRunOptions } from '../src/sniper/executors/dryRun';
import type { SnipeRule, NormalizedTweet, SendOutcome } from '../src/sniper/types';

const NOW = 1_785_000_000_000;

function rule(over: Partial<SnipeRule> = {}): SnipeRule {
  return {
    id: 'r1', userId: 'u1', name: 'test', state: 'armed', chain: 'sol', venue: 'dryrun',
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

function harness(opts: {
  wallets?: { walletId: string; perFireCap?: number; dailyCap?: number; maxOpen?: number; unit?: 'SOL' | 'BNB' | 'USDC' }[];
  dryRunOpts?: DryRunOptions;
  clock?: () => number;
  pushedMcap?: (mint: string) => number | undefined;
}) {
  const store = new InMemorySniperStore();
  for (const w of opts.wallets ?? [{ walletId: 'w1' }]) {
    store.putWallet({
      walletId: w.walletId, chain: 'sol', unit: w.unit ?? 'SOL',
      perFireCap: w.perFireCap ?? 5, dailyCap: w.dailyCap ?? 100, maxOpen: w.maxOpen ?? 5,
    });
  }
  const registry = new ExecutorRegistry(new DryRunExecutor(opts.dryRunOpts));
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
    const deps = harness({});
    const r = rule();
    deps.store.putRule(r);
    const res = await executeFire(r, tweet, deps);
    expect(res.outcome).toBe('fired');
    expect(res.legs).toHaveLength(1);
    expect(res.legs[0].state).toBe('filled');
    expect(res.legs[0].signature).toMatch(/^DRYRUN-/);
    expect(res.ruleDisabled).toBe(true);
    expect(deps.store.getRule('r1')!.state).toBe('disabled');
  });
});

describe('executeFire — idempotency', () => {
  it('suppresses a duplicate delivery of the same trigger', async () => {
    const deps = harness({});
    const r = rule({ autoDisableAfterFire: false });
    deps.store.putRule(r);
    const first = await executeFire(r, tweet, deps);
    const second = await executeFire(r, tweet, deps);
    expect(first.outcome).toBe('fired');
    expect(second.outcome).toBe('suppressed');
    // Exactly one fill recorded.
    expect(deps.store.fireLog().filter((f) => f.state === 'filled')).toHaveLength(1);
  });
});

describe('executeFire — caps bind (M4)', () => {
  it('ladder of 5 legs each at perFireCap spends perTriggerCap, not 5x', async () => {
    // Each leg is 1 SOL (sizeTotal 5, split evenly ×5 → 1 each). perTriggerCap 6
    // (5 SOL + fees) allows it; 5.5 would not.
    const deps = harness({ wallets: [{ walletId: 'w1', perFireCap: 2, dailyCap: 100 }] });
    const r = rule({
      entryStyle: 'ladder', ladderSplit: [0.2, 0.2, 0.2, 0.2, 0.2], sizeTotal: 5,
      perFireCap: 2, perTriggerCap: 6,
    });
    deps.store.putRule(r);
    const res = await executeFire(r, tweet, deps);
    expect(res.outcome).toBe('fired');
    expect(res.legs).toHaveLength(5);
    expect(res.legs.every((l) => l.state === 'filled')).toBe(true);
    const snap = deps.store.budgetSnapshot('w1', 'sol', new Date(NOW).toISOString().slice(0, 10))!;
    // 5 legs × (1 + 0.5% fee) = 5.025 spent — bounded, not 25.
    expect(snap.spentToday).toBeCloseTo(5.025, 3);
  });

  it('aborts the whole trigger when perTriggerCap is exceeded, before any send', async () => {
    const deps = harness({ wallets: [{ walletId: 'w1', perFireCap: 100 }] });
    const r = rule({ sizeTotal: 10, perTriggerCap: 5 }); // 10 + fees > 5
    deps.store.putRule(r);
    const res = await executeFire(r, tweet, deps);
    expect(res.outcome).toBe('aborted');
    expect(res.reason).toBe('per_trigger_cap');
    expect(deps.store.fireLog()).toHaveLength(0); // nothing sent
  });

  it('multi-wallet fan-out is N fires against N budgets, one trigger', async () => {
    const deps = harness({ wallets: [{ walletId: 'w1' }, { walletId: 'w2' }] });
    const r = rule({ walletIds: ['w1', 'w2'], sizeTotal: 1, perTriggerCap: 100 });
    deps.store.putRule(r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs).toHaveLength(2);
    const day = new Date(NOW).toISOString().slice(0, 10);
    expect(deps.store.budgetSnapshot('w1', 'sol', day)!.openPositions).toBe(1);
    expect(deps.store.budgetSnapshot('w2', 'sol', day)!.openPositions).toBe(1);
  });
});

describe('executeFire — abort and expire', () => {
  it('aborts on the kill switch before firing', async () => {
    const deps = harness({});
    const r = rule();
    deps.store.putRule(r);
    deps.store.setKillSwitch(true);
    const res = await executeFire(r, tweet, deps);
    expect(res.outcome).toBe('aborted');
    expect(res.reason).toBe('kill_switch');
  });

  it('aborts a leg when a pushed market cap exceeds the ceiling', async () => {
    const deps = harness({ pushedMcap: () => 2_000_000 });
    const r = rule({ mcapCeiling: 1_000_000 });
    deps.store.putRule(r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('aborted');
    expect(res.legs[0].reason).toBe('mcap_ceiling');
  });

  it('expires a leg once the fire window is exhausted', async () => {
    // Clock advances past fireWindowMs while the executor keeps returning dead.
    let t = NOW;
    const dead: SendOutcome = { kind: 'dead', reason: 'network', status: 0 };
    const deps = harness({
      dryRunOpts: { outcomeFor: () => dead },
      clock: () => (t += 20_000), // each read jumps 20s; fireWindowMs is 30s
    });
    const r = rule({ fireWindowMs: 30_000, maxAttempts: 10 });
    deps.store.putRule(r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('expired');
  });

  it('retries a provably-dead send, then fills', async () => {
    let calls = 0;
    const deps = harness({
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
    deps.store.putRule(r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('filled');
    expect(res.legs[0].attempts).toBe(2);
  });
});

describe('executeFire — indeterminate outcome is never retried', () => {
  it('holds the reservation on unknown and does not re-send', async () => {
    let calls = 0;
    const deps = harness({
      dryRunOpts: { outcomeFor: () => { calls++; return { kind: 'unknown' }; } },
    });
    const r = rule();
    deps.store.putRule(r);
    const res = await executeFire(r, tweet, deps);
    expect(res.legs[0].state).toBe('unknown');
    expect(calls).toBe(1); // exactly one send — a timeout that landed must not double-buy
    const day = new Date(NOW).toISOString().slice(0, 10);
    // Reservation held (not released).
    expect(deps.store.budgetSnapshot('w1', 'sol', day)!.openPositions).toBe(1);
  });
});
