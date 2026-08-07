import { describe, it, expect } from 'vitest';
import { InMemorySniperStore, utcDay } from '../src/sniper/store';
import type { WalletConfig } from '../src/sniper/types';

const wallet = (over: Partial<WalletConfig> = {}): WalletConfig => ({
  walletId: 'w1', label: 'main', venue: 'slotshark', address: 'So11111111111111111111111111111111111111112',
  chain: 'sol', unit: 'SOL', perFireCap: 5, dailyCap: 10, maxOpen: 3, ...over,
});

const DAY = utcDay(1_785_000_000_000); // fixed instant
const U = 'u1';

describe('reserveLeg — the atomic cap reservation', () => {
  it('debits spentToday and openPositions on success', async () => {
    const s = new InMemorySniperStore();
    await s.putWallet(U, wallet());
    const r = await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 2 });
    expect(r.ok).toBe(true);
    const snap = (await s.budgetSnapshot(U, 'w1', 'sol', DAY))!;
    expect(snap.spentToday).toBe(2);
    expect(snap.openPositions).toBe(1);
  });

  it('rejects a leg over the per-fire cap', async () => {
    const s = new InMemorySniperStore();
    await s.putWallet(U, wallet({ perFireCap: 1 }));
    expect(await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 2 }))
      .toEqual({ ok: false, reason: 'per_fire_cap' });
  });

  it('rejects once the daily cap would be exceeded', async () => {
    const s = new InMemorySniperStore();
    await s.putWallet(U, wallet({ perFireCap: 6, dailyCap: 10 }));
    expect((await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 6 })).ok).toBe(true);
    // 6 + 6 = 12 > 10
    expect(await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 6 }))
      .toEqual({ ok: false, reason: 'daily_cap' });
  });

  it('rejects once max open positions is reached', async () => {
    const s = new InMemorySniperStore();
    await s.putWallet(U, wallet({ maxOpen: 1, dailyCap: 100, perFireCap: 100 }));
    expect((await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 1 })).ok).toBe(true);
    expect(await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 1 }))
      .toEqual({ ok: false, reason: 'max_open' });
  });

  it('rejects a unit mismatch rather than comparing incommensurable numbers', async () => {
    const s = new InMemorySniperStore();
    await s.putWallet(U, wallet({ unit: 'USDC', perFireCap: 1000, dailyCap: 1000 }));
    // 5 SOL against a 1000-USDC cap must NOT pass just because 5 <= 1000.
    expect(await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 5 }))
      .toEqual({ ok: false, reason: 'unit_mismatch' });
  });

  it('rejects an unknown wallet', async () => {
    const s = new InMemorySniperStore();
    expect(await s.reserveLeg(U, { walletId: 'ghost', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 1 }))
      .toEqual({ ok: false, reason: 'no_wallet' });
  });

  it('creates the day row on first use — no "first fire of the day refused" bug', async () => {
    const s = new InMemorySniperStore();
    await s.putWallet(U, wallet());
    // A brand new day string that has never been seen.
    const newDay = utcDay(1_785_000_000_000 + 86_400_000);
    expect((await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: newDay, amountWithFees: 1 })).ok).toBe(true);
  });

  it('release reverses the debit and closes the position', async () => {
    const s = new InMemorySniperStore();
    await s.putWallet(U, wallet());
    await s.reserveLeg(U, { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 3 });
    await s.releaseLeg(U, { walletId: 'w1', chain: 'sol', day: DAY, amountWithFees: 3, closePosition: true });
    const snap = (await s.budgetSnapshot(U, 'w1', 'sol', DAY))!;
    expect(snap.spentToday).toBe(0);
    expect(snap.openPositions).toBe(0);
  });

  // The bug this guards: InMemorySniperStore keyed rules, wallets, budgets AND
  // the kill switch on nothing at all. In hosted mode that means one user's kill
  // switch stops everyone's fires and one user's budget bounds another's.
  it('scopes wallets, budgets and the kill switch per user', async () => {
    const s = new InMemorySniperStore();
    await s.putWallet('alice', wallet());
    await s.setKillSwitch('alice', true, 'testing');

    expect(await s.getWallet('bob', 'w1')).toBeNull();
    expect(await s.isKilled('bob')).toBe(false);
    expect(await s.isKilled('alice')).toBe(true);
    // Bob cannot reserve against Alice's wallet, so her cap never bounds him
    // and his spending never shows up on her budget.
    expect(await s.reserveLeg('bob', { walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 1 }))
      .toEqual({ ok: false, reason: 'no_wallet' });
  });
});
