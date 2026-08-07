import { useCallback, useEffect, useState } from 'react';
import { sniperJson } from '../lib/sniperApi';
import type { BudgetRow, SniperWallet } from '../types/sniper';

export type SniperWalletDraft = Pick<
  SniperWallet,
  'label' | 'chain' | 'venue' | 'address' | 'unit' | 'perFireCap' | 'dailyCap' | 'maxOpen'
>;

/** PATCH is a subset: chain and venue are immutable (they key the budget rows). */
export type SniperWalletPatch = Partial<
  Pick<SniperWallet, 'label' | 'address' | 'unit' | 'perFireCap' | 'dailyCap' | 'maxOpen'>
>;

/**
 * Wallets and today's budget together, because the wallets table renders
 * `spentToday / dailyCap` inline — two hooks would let the table show a cap from
 * one fetch against a spend from another.
 */
export function useSniperWallets() {
  const [wallets, setWallets] = useState<SniperWallet[]>([]);
  const [budget, setBudget] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [walletRes, budgetRes] = await Promise.all([
      sniperJson<{ wallets: SniperWallet[] }>('/wallets'),
      sniperJson<{ day: string; rows: BudgetRow[] }>('/budget'),
    ]);

    if (walletRes.ok) {
      setWallets(walletRes.data.wallets);
      setError(null);
    } else {
      setError(walletRes.reason);
    }
    // Budget is an overlay on the wallets table; a failed budget fetch must not
    // hide the wallets themselves, so it only clears the overlay.
    setBudget(budgetRes.ok ? budgetRes.data.rows : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createWallet = useCallback(
    async (draft: SniperWalletDraft) => {
      const res = await sniperJson<{ wallet: SniperWallet }>('/wallets', {
        method: 'POST',
        body: JSON.stringify(draft),
      });
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  const updateWallet = useCallback(
    async (walletId: string, patch: SniperWalletPatch) => {
      const res = await sniperJson<{ wallet: SniperWallet }>(`/wallets/${walletId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  const deleteWallet = useCallback(
    async (walletId: string) => {
      // 409 `wallet_in_use` when a rule references it — the caller renders the
      // returned rule ids rather than a generic failure.
      const res = await sniperJson<void>(`/wallets/${walletId}`, { method: 'DELETE' });
      if (res.ok) await refresh();
      return res;
    },
    [refresh],
  );

  return { wallets, budget, loading, error, refresh, createWallet, updateWallet, deleteWallet };
}
