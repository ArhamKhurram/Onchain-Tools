import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '../lib/supabase';

/**
 * Shared CRUD hook backing the near-identical tracked- and holding-wallet hooks.
 *
 * Both hooks are the same fetch-once-on-mount + optimistic create/update/delete
 * shape over a per-user Supabase table (RLS-scoped; `user_id` is set on insert
 * but the row-level policy keys off `auth.uid()`). The only differences are the
 * table name and the row/insert/update types, so those are supplied by the
 * caller. `getSupabase()` returns an untyped `SupabaseClient` (no Database
 * generic), so the query builder is untyped and results are cast to the
 * caller-supplied row type — exactly as the original hooks did.
 */
export interface WalletCrudHook<Row, Insert, Update> {
  wallets: Row[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createWallet: (payload: Insert) => Promise<Row>;
  updateWallet: (id: string, payload: Update) => Promise<Row>;
  deleteWallet: (id: string) => Promise<void>;
}

export function useWalletCrud<Row extends { id: string }, Insert extends object, Update extends object>(
  table: string,
  userId: string | undefined,
): WalletCrudHook<Row, Insert, Update> {
  const [wallets, setWallets] = useState<Row[]>([]);
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
      .from(table)
      .select('*')
      .order('created_at', { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
      setWallets([]);
    } else {
      setWallets((data as Row[]) ?? []);
    }
    setLoading(false);
  }, [table, userId]);

  useEffect(() => {
    fetchWallets();
  }, [fetchWallets]);

  const createWallet = useCallback(
    async (payload: Insert) => {
      if (!userId) throw new Error('Not signed in');

      const { data, error: insertError } = await getSupabase()
        .from(table)
        .insert({ ...payload, user_id: userId })
        .select()
        .single();

      if (insertError) throw insertError;
      const row = data as Row;
      setWallets((prev) => [row, ...prev]);
      return row;
    },
    [table, userId],
  );

  const updateWallet = useCallback(
    async (id: string, payload: Update) => {
      const { data, error: updateError } = await getSupabase()
        .from(table)
        .update(payload)
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;
      const row = data as Row;
      setWallets((prev) => prev.map((w) => (w.id === id ? row : w)));
      return row;
    },
    [table],
  );

  const deleteWallet = useCallback(
    async (id: string) => {
      const { error: deleteError } = await getSupabase().from(table).delete().eq('id', id);

      if (deleteError) throw deleteError;
      setWallets((prev) => prev.filter((w) => w.id !== id));
    },
    [table],
  );

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
