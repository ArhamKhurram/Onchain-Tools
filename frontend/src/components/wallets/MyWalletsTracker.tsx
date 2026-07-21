import { useMemo, useState } from 'react';
import { Plus, Search, Pencil, Trash2, Copy, Check, RefreshCw, Wallet } from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import HoldingWalletFormModal, { type HoldingWalletFormValues } from './HoldingWalletFormModal';
import { useHoldingWallets } from '../../hooks/useHoldingWallets';
import type { HoldingWallet } from '../../types/holdingWallets';
import type { WalletChain } from '../../types/wallets';
import { CHAIN_META, truncateAddress, WALLET_CHAINS } from '../../types/wallets';

interface MyWalletsTrackerProps {
  userId: string;
}

type ChainFilter = WalletChain | 'all';

export default function MyWalletsTracker({ userId }: MyWalletsTrackerProps) {
  const { wallets, loading, error, refresh, createWallet, updateWallet, deleteWallet } =
    useHoldingWallets(userId);

  const [search, setSearch] = useState('');
  const [chainFilter, setChainFilter] = useState<ChainFilter>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add');
  const [editingWallet, setEditingWallet] = useState<HoldingWallet | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HoldingWallet | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = wallets;
    if (chainFilter !== 'all') {
      result = result.filter((w) => w.chain === chainFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (w) => w.address.toLowerCase().includes(q) || w.label.toLowerCase().includes(q),
      );
    }
    return result;
  }, [wallets, chainFilter, search]);

  const handleCopy = (wallet: HoldingWallet) => {
    navigator.clipboard.writeText(wallet.address);
    setCopiedId(wallet.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const openAdd = () => {
    setFormMode('add');
    setEditingWallet(null);
    setActionError(null);
    setFormOpen(true);
  };

  const openEdit = (wallet: HoldingWallet) => {
    setFormMode('edit');
    setEditingWallet(wallet);
    setActionError(null);
    setFormOpen(true);
  };

  const handleFormSubmit = async (values: HoldingWalletFormValues) => {
    setActionError(null);
    if (formMode === 'add') {
      await createWallet(values);
    } else if (editingWallet) {
      const { address: _addr, ...updates } = values;
      await updateWallet(editingWallet.id, updates);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setActionError(null);
    try {
      await deleteWallet(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete wallet');
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-oct-bg">
      <div className="shrink-0 border-b-2 border-black bg-oct-surface px-4 sm:px-6 py-3">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Wallet size={18} className="text-oct-accent" />
            <h1 className="text-lg font-extrabold uppercase text-oct-text">My Wallets</h1>
            <span className="text-xs font-mono text-oct-muted tabular-nums">{filtered.length}</span>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="p-2 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-text hover:border-oct-text transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button type="button" onClick={openAdd} className="brutal-btn px-3 py-1.5 text-sm">
            <Plus size={16} />
            Add wallet
          </button>
        </div>

        <p className="text-xs text-oct-muted mb-3 max-w-2xl">
          Your trading wallets — checked on-chain for missed-runner alerts when a scan pumps without you holding.
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-oct-muted pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search address or label…"
              className="w-full pl-9 pr-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
            />
          </div>
          <div className="flex gap-1 p-0.5 rounded-cockpit bg-oct-bg border-2 border-oct-border">
            {WALLET_CHAINS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setChainFilter(value)}
                className={`px-2.5 py-1.5 rounded-cockpit text-xs font-bold uppercase transition-colors whitespace-nowrap ${
                  chainFilter === value
                    ? 'bg-oct-accent text-white'
                    : 'text-oct-muted hover:text-oct-text'
                }`}
              >
                {value === 'all' ? 'All' : CHAIN_META[value].short}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {(error || actionError) && (
          <div className="m-4 px-4 py-3 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-sm text-oct-accent">
            {error ?? actionError}
          </div>
        )}

        {loading && wallets.length === 0 ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center px-6">
            <div className="w-12 h-12 rounded-cockpit border-2 border-black bg-oct-accent shadow-oct-hard flex items-center justify-center mb-4">
              <Wallet size={24} className="text-white" />
            </div>
            <p className="text-oct-text font-bold uppercase mb-1">
              {wallets.length === 0 ? 'No wallets added yet' : 'No matches'}
            </p>
            <p className="text-sm text-oct-muted mb-5 max-w-sm">
              {wallets.length === 0
                ? 'Add the addresses you actually buy from so missed-runner knows when you skipped a call.'
                : 'Try a different search or chain filter.'}
            </p>
            {wallets.length === 0 && (
              <button type="button" onClick={openAdd} className="brutal-btn px-4 py-2 text-sm">
                <Plus size={16} />
                Add your first wallet
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-cockpit border-2 border-black shadow-oct-hard overflow-hidden m-4 sm:m-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-black bg-oct-surface text-left font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
                  <th className="px-4 py-2.5">Chain</th>
                  <th className="px-4 py-2.5">Address</th>
                  <th className="px-4 py-2.5">Label</th>
                  <th className="px-4 py-2.5 w-24" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((wallet) => (
                  <tr
                    key={wallet.id}
                    className="border-b border-oct-border/60 hover:bg-oct-surface-raised/40 transition-colors group"
                  >
                    <td className="px-4 py-3">
                      <span
                        className="text-[10px] font-bold px-1.5 py-0.5 rounded-cockpit uppercase font-mono"
                        style={{
                          backgroundColor: `${CHAIN_META[wallet.chain].color}20`,
                          color: CHAIN_META[wallet.chain].color,
                        }}
                      >
                        {CHAIN_META[wallet.chain].short}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-sm text-oct-text truncate" title={wallet.address}>
                          {truncateAddress(wallet.address)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopy(wallet)}
                          className="p-1 rounded text-oct-muted hover:text-oct-text opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Copy address"
                        >
                          {copiedId === wallet.id ? (
                            <Check size={14} className="text-green-400" />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-oct-text">{wallet.label || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={() => openEdit(wallet)}
                          className="p-1.5 rounded-cockpit text-oct-muted hover:text-oct-text"
                          title="Edit"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(wallet)}
                          className="p-1.5 rounded-cockpit text-oct-muted hover:text-oct-accent"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <HoldingWalletFormModal
        open={formOpen}
        mode={formMode}
        wallet={editingWallet}
        onClose={() => setFormOpen(false)}
        onSubmit={handleFormSubmit}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title="Remove wallet"
        message={`Remove ${deleteTarget ? truncateAddress(deleteTarget.address) : 'this wallet'} from My Wallets?`}
        confirmLabel="Remove"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
