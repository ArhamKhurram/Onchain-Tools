import { useMemo, useState } from 'react';
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Copy,
  Check,
  RefreshCw,
  Wallet,
  Bell,
  Rss,
  CircleDot,
} from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import WalletFormModal, { type WalletFormValues } from './WalletFormModal';
import { useTrackedWallets } from '../../hooks/useTrackedWallets';
import type { TrackedWallet, WalletChain } from '../../types/wallets';
import { CHAIN_META, truncateAddress, WALLET_CHAINS } from '../../types/wallets';

interface WalletTrackerProps {
  userId: string;
}

type ChainFilter = WalletChain | 'all';

export default function WalletTracker({ userId }: WalletTrackerProps) {
  const { wallets, loading, error, refresh, createWallet, updateWallet, deleteWallet } =
    useTrackedWallets(userId);

  const [search, setSearch] = useState('');
  const [chainFilter, setChainFilter] = useState<ChainFilter>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add');
  const [editingWallet, setEditingWallet] = useState<TrackedWallet | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TrackedWallet | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = wallets;
    if (chainFilter !== 'all') {
      result = result.filter((w) => w.chain === chainFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (w) =>
          w.address.toLowerCase().includes(q) ||
          w.name.toLowerCase().includes(q) ||
          w.profile.toLowerCase().includes(q) ||
          w.emoji.includes(q),
      );
    }
    return result;
  }, [wallets, chainFilter, search]);

  const handleCopy = (wallet: TrackedWallet) => {
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

  const openEdit = (wallet: TrackedWallet) => {
    setFormMode('edit');
    setEditingWallet(wallet);
    setActionError(null);
    setFormOpen(true);
  };

  const handleFormSubmit = async (values: WalletFormValues) => {
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
      {/* Toolbar */}
      <div className="shrink-0 border-b border-oct-border bg-oct-surface px-4 sm:px-6 py-3">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Wallet size={18} className="text-oct-accent" />
            <h1 className="text-lg font-bold text-oct-text">Wallets</h1>
            <span className="text-xs font-mono text-oct-muted tabular-nums">{filtered.length}</span>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="p-2 rounded-lg text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-oct-accent hover:bg-oct-accent-hover text-white transition-colors shadow-oct-glow"
          >
            <Plus size={16} />
            Add wallet
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-oct-muted pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search address, label, profile…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-oct-bg border border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
            />
          </div>
          <div className="flex gap-1 p-0.5 rounded-lg bg-oct-bg border border-oct-border">
            {WALLET_CHAINS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => setChainFilter(value)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  chainFilter === value
                    ? 'bg-oct-accent-dim text-oct-accent'
                    : 'text-oct-muted hover:text-oct-text'
                }`}
              >
                {value === 'all' ? 'All' : CHAIN_META[value].short}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto px-4 sm:px-6 py-4">
        {(error || actionError) && (
          <div className="mb-4 px-4 py-3 rounded-lg border border-oct-accent/40 bg-oct-accent-dim text-sm text-oct-accent">
            {error ?? actionError}
          </div>
        )}

        {loading && wallets.length === 0 ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-12 h-12 rounded-xl bg-oct-accent-dim flex items-center justify-center mb-4">
              <Wallet size={24} className="text-oct-accent" />
            </div>
            <p className="text-oct-text font-medium mb-1">
              {wallets.length === 0 ? 'No wallets tracked yet' : 'No matches'}
            </p>
            <p className="text-sm text-oct-muted mb-5 max-w-sm">
              {wallets.length === 0
                ? 'Add an address to start monitoring on-chain activity.'
                : 'Try a different search or chain filter.'}
            </p>
            {wallets.length === 0 && (
              <button
                type="button"
                onClick={openAdd}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-oct-accent hover:bg-oct-accent-hover text-white transition-colors"
              >
                <Plus size={16} />
                Add your first wallet
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-oct-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-oct-surface border-b border-oct-border text-left">
                  <th className="px-3 py-2.5 text-xs font-medium text-oct-muted uppercase tracking-wide">Wallet</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-oct-muted uppercase tracking-wide hidden md:table-cell">Address</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-oct-muted uppercase tracking-wide w-20">Chain</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-oct-muted uppercase tracking-wide hidden lg:table-cell w-28">Alerts</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-oct-muted uppercase tracking-wide w-24 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-oct-border">
                {filtered.map((wallet) => (
                  <WalletRow
                    key={wallet.id}
                    wallet={wallet}
                    copied={copiedId === wallet.id}
                    onCopy={() => handleCopy(wallet)}
                    onEdit={() => openEdit(wallet)}
                    onDelete={() => setDeleteTarget(wallet)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <WalletFormModal
        open={formOpen}
        mode={formMode}
        wallet={editingWallet}
        onClose={() => setFormOpen(false)}
        onSubmit={handleFormSubmit}
      />

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete wallet?"
        message={
          deleteTarget
            ? `Remove ${deleteTarget.name || truncateAddress(deleteTarget.address)} from your watchlist? This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function WalletRow({
  wallet,
  copied,
  onCopy,
  onEdit,
  onDelete,
}: {
  wallet: TrackedWallet;
  copied: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const chain = CHAIN_META[wallet.chain];
  const displayName = wallet.name || truncateAddress(wallet.address);

  return (
    <tr className="bg-oct-surface/50 hover:bg-oct-surface-raised/80 transition-colors group">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base shrink-0 w-6 text-center">{wallet.emoji || '·'}</span>
          <div className="min-w-0">
            <div className="font-medium text-oct-text truncate">{displayName}</div>
            <div className="text-xs text-oct-muted truncate">{wallet.profile}</div>
            <div className="md:hidden font-mono text-xs text-oct-muted truncate mt-0.5">{truncateAddress(wallet.address, 8, 6)}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 hidden md:table-cell">
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 font-mono text-xs text-oct-muted hover:text-oct-accent transition-colors max-w-[220px]"
          title={wallet.address}
        >
          <span className="truncate">{truncateAddress(wallet.address, 8, 6)}</span>
          {copied ? <Check size={12} className="text-oct-green shrink-0" /> : <Copy size={12} className="shrink-0 opacity-0 group-hover:opacity-100" />}
        </button>
      </td>
      <td className="px-3 py-2.5">
        <span
          className="inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
          style={{ color: chain.color, backgroundColor: `${chain.color}18` }}
        >
          {chain.short}
        </span>
      </td>
      <td className="px-3 py-2.5 hidden lg:table-cell">
        <div className="flex items-center gap-2 text-oct-muted">
          <AlertIcon active={wallet.alerts_on_toast} icon={Bell} title="Toast" />
          <AlertIcon active={wallet.alerts_on_feed} icon={Rss} title="Feed" />
          <AlertIcon active={wallet.alerts_on_bubble} icon={CircleDot} title="Bubble" />
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="p-1.5 rounded-md text-oct-muted hover:text-oct-text hover:bg-oct-bg transition-colors"
            title="Edit"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="p-1.5 rounded-md text-oct-muted hover:text-oct-accent hover:bg-oct-accent-dim transition-colors"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function AlertIcon({
  active,
  icon: Icon,
  title,
}: {
  active: boolean;
  icon: typeof Bell;
  title: string;
}) {
  return (
    <span title={`${title}: ${active ? 'on' : 'off'}`} className={active ? 'text-oct-accent' : 'opacity-30'}>
      <Icon size={13} />
    </span>
  );
}
