import { describe, it, expect } from 'vitest';
import { InMemorySniperStore, utcDay } from '../src/sniper/store';
import type { WalletConfig } from '../src/sniper/store';

const wallet = (over: Partial<WalletConfig> = {}): WalletConfig => ({
  walletId: 'w1', chain: 'sol', unit: 'SOL', perFireCap: 5, dailyCap: 10, maxOpen: 3, ...over,
});

const DAY = utcDay(1_785_000_000_000); // fixed instant

describe('reserveLeg — the atomic cap reservation', () => {
  it('debits spentToday and openPositions on success', () => {
    const s = new InMemorySniperStore();
    s.putWallet(wallet());
    const r = s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 2 });
    expect(r.ok).toBe(true);
    const snap = s.budgetSnapshot('w1', 'sol', DAY)!;
    expect(snap.spentToday).toBe(2);
    expect(snap.openPositions).toBe(1);
  });

  it('rejects a leg over the per-fire cap', () => {
    const s = new InMemorySniperStore();
    s.putWallet(wallet({ perFireCap: 1 }));
    expect(s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 2 }))
      .toEqual({ ok: false, reason: 'per_fire_cap' });
  });

  it('rejects once the daily cap would be exceeded', () => {
    const s = new InMemorySniperStore();
    s.putWallet(wallet({ perFireCap: 6, dailyCap: 10 }));
    expect(s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 6 }).ok).toBe(true);
    // 6 + 6 = 12 > 10
    expect(s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 6 }))
      .toEqual({ ok: false, reason: 'daily_cap' });
  });

  it('rejects once max open positions is reached', () => {
    const s = new InMemorySniperStore();
    s.putWallet(wallet({ maxOpen: 1, dailyCap: 100, perFireCap: 100 }));
    expect(s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 1 }).ok).toBe(true);
    expect(s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 1 }))
      .toEqual({ ok: false, reason: 'max_open' });
  });

  it('rejects a unit mismatch rather than comparing incommensurable numbers', () => {
    const s = new InMemorySniperStore();
    s.putWallet(wallet({ unit: 'USDC', perFireCap: 1000 }));
    // 5 SOL against a 1000-USDC cap must NOT pass just because 5 <= 1000.
    expect(s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 5 }))
      .toEqual({ ok: false, reason: 'unit_mismatch' });
  });

  it('rejects an unknown wallet', () => {
    const s = new InMemorySniperStore();
    expect(s.reserveLeg({ walletId: 'ghost', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 1 }))
      .toEqual({ ok: false, reason: 'no_wallet' });
  });

  it('creates the day row on first use — no "first fire of the day refused" bug', () => {
    const s = new InMemorySniperStore();
    s.putWallet(wallet());
    // A brand new day string that has never been seen.
    const newDay = utcDay(1_785_000_000_000 + 86_400_000);
    expect(s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: newDay, amountWithFees: 1 }).ok).toBe(true);
  });

  it('release reverses the debit and closes the position', () => {
    const s = new InMemorySniperStore();
    s.putWallet(wallet());
    s.reserveLeg({ walletId: 'w1', chain: 'sol', unit: 'SOL', day: DAY, amountWithFees: 3 });
    s.releaseLeg({ walletId: 'w1', chain: 'sol', day: DAY, amountWithFees: 3, closePosition: true });
    const snap = s.budgetSnapshot('w1', 'sol', DAY)!;
    expect(snap.spentToday).toBe(0);
    expect(snap.openPositions).toBe(0);
  });
});
