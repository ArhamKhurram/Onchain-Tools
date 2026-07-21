import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import type { HoldingWallet, HoldingWalletInsert, HoldingWalletUpdate } from '../types/holdingWallets';

export function useHoldingWallets(userId: string | undefined) {
  const [wallets, setWallets] = useState<HoldingWallet[]>([]);
  const [loading, setLoading] = useState(!!userId);
  const [error, setError] = useState<string | null>(null);

  const fetchWallets = useCallback(async () => {
    if (!userId) {
      setWallets([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await getSupabase()
      .from('user_holding_wallets')
      .select('*')
      .order('created_at', { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setWallets([]);
    } else {
      setWallets((data as HoldingWallet[]) ?? []);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    fetchWallets();
  }, [fetchWallets]);

  const createWallet = useCallback(
    async (payload: HoldingWalletInsert) => {
      if (!userId) throw new Error('Not signed in');

      const { data, error: insertError } = await getSupabase()
        .from('user_holding_wallets')
        .insert({ ...payload, user_id: userId })
        .select()
        .single();

      if (insertError) throw insertError;
      const row = data as HoldingWallet;
      setWallets((prev) => [row, ...prev]);
      return row;
    },
    [userId],
  );

  const updateWallet = useCallback(async (id: string, payload: HoldingWalletUpdate) => {
    const { data, error: updateError } = await getSupabase()
      .from('user_holding_wallets')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;
    const row = data as HoldingWallet;
    setWallets((prev) => prev.map((w) => (w.id === id ? row : w)));
    return row;
  }, []);

  const deleteWallet = useCallback(async (id: string) => {
    const { error: deleteError } = await getSupabase()
      .from('user_holding_wallets')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;
    setWallets((prev) => prev.filter((w) => w.id !== id));
  }, []);

  return {
    wallets,
    loading,
    error,
    refresh: fetchWallets,
    createWallet,
    updateWallet,
    deleteWallet,
  };
}
