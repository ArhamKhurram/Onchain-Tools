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
import Chip from '../common/Chip';
import WalletFormModal, { type WalletFormValues } from './WalletFormModal';
import { useTrackedWallets } from '../../hooks/useTrackedWallets';
import { cn } from '../../lib/utils';
import type { TrackedWallet, WalletChain } from '../../types/wallets';
import { CHAIN_META, truncateAddress, WALLET_CHAINS } from '../../types/wallets';

// ── Tracked-wallet directory ─────────────────────────────────────────────────
// A blotter, not a card grid: one dense table, mono addresses, tabular digits.
// Type roles carry the hierarchy (`type-title` for the page, `type-caption`
// for column labels, `type-data` for every address), so the row height comes
// down to the content rather than the padding. No motion here — the table is
// user-driven, not streamed, but the page-level entrance in DirectoryPage
// already covers it and a second animation on the same surface would stack.

interface WalletTrackerProps {
  userId: string;
}

type ChainFilter = WalletChain | 'all';

/**
 * Column labels. `type-caption` (12px) mono with the wide tracking the legacy
 * `.oct-eyebrow` helper uses — that helper is 11px, under the floor, and being
 * a utilities-layer class it cannot be lifted from a call site.
 */
const TH_CLASS = 'px-comfy py-snug type-caption font-mono uppercase tracking-[0.14em] text-oct-muted text-left';
const TD_CLASS = 'px-comfy py-snug';

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
      <div className="oct-headerbar shrink-0 px-roomy sm:px-section py-cozy">
        <div className="flex flex-wrap items-center gap-comfy mb-cozy">
          <div className="flex items-center gap-cozy">
            <Wallet size={16} className="text-oct-accent" />
            <h1 className="type-title uppercase tracking-wide text-oct-text">Tracked Wallets</h1>
            <Chip>{filtered.length}</Chip>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="oct-icon-btn p-snug"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button type="button" onClick={openAdd} className="oct-btn-primary px-comfy py-snug type-label">
            <Plus size={14} />
            Add wallet
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-cozy">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-cozy top-1/2 -translate-y-1/2 text-oct-muted pointer-events-none"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search address, label, profile…"
              className="oct-input w-full pl-8 pr-comfy py-snug type-body"
            />
          </div>
          <div className="flex gap-tight p-hair rounded-oct bg-oct-bg border border-oct-border">
            {WALLET_CHAINS.map(({ value }) => (
              <button
                key={value}
                type="button"
                onClick={() => setChainFilter(value)}
                className={cn(
                  'px-cozy py-tight rounded-oct-sm type-caption font-bold uppercase transition-all duration-fast whitespace-nowrap',
                  chainFilter === value
                    ? 'bg-oct-accent text-white shadow-oct-glow-accent'
                    : 'text-oct-muted hover:text-oct-text',
                )}
              >
                {value === 'all' ? 'All' : CHAIN_META[value].short}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto px-roomy sm:px-section py-comfy">
        {(error || actionError) && (
          // `oct-critical`, not the accent: the accent is a red in the dark theme,
          // so an error styled with it reads as branded chrome.
          <div
            role="alert"
            className="mb-comfy px-comfy py-cozy rounded-oct border border-oct-critical/50 bg-oct-critical-dim type-body text-oct-critical"
          >
            {error ?? actionError}
          </div>
        )}

        {loading && wallets.length === 0 ? (
          <div className="flex items-center justify-center py-gutter">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-gutter text-center">
            <div className="w-12 h-12 rounded-oct-lg border border-oct-border bg-oct-surface-raised flex items-center justify-center mb-comfy">
              <Wallet size={20} className="text-oct-muted" />
            </div>
            <p className="type-title uppercase tracking-wide text-oct-text mb-tight">
              {wallets.length === 0 ? 'No wallets tracked yet' : 'No matches'}
            </p>
            <p className="type-body text-oct-muted mb-roomy max-w-sm leading-relaxed">
              {wallets.length === 0
                ? 'Add whale or KOL addresses to monitor their on-chain activity.'
                : 'Try a different search or chain filter.'}
            </p>
            {wallets.length === 0 && (
              <button type="button" onClick={openAdd} className="oct-btn-primary px-roomy py-cozy type-label">
                <Plus size={14} />
                Add your first tracked wallet
              </button>
            )}
          </div>
        ) : (
          <div className="oct-card oct-card-flush overflow-hidden">
            <table className="w-full type-body">
              <thead className="oct-thead">
                <tr>
                  <th className={TH_CLASS}>Wallet</th>
                  <th className={cn(TH_CLASS, 'hidden md:table-cell')}>Address</th>
                  <th className={cn(TH_CLASS, 'w-20')}>Chain</th>
                  <th className={cn(TH_CLASS, 'hidden lg:table-cell w-28')}>Alerts</th>
                  <th className={cn(TH_CLASS, 'w-24 text-right')}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-oct-border/60">
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
    <tr className="oct-row-hover group">
      <td className={TD_CLASS}>
        <div className="flex items-center gap-cozy min-w-0">
          <span className="text-base shrink-0 w-6 text-center leading-none">{wallet.emoji || '·'}</span>
          <div className="min-w-0">
            <div className="type-label text-oct-text truncate">{displayName}</div>
            <div className="type-caption text-oct-muted truncate">{wallet.profile}</div>
            <div className="md:hidden type-data text-oct-muted truncate mt-hair">
              {truncateAddress(wallet.address, 8, 6)}
            </div>
          </div>
        </div>
      </td>
      <td className={cn(TD_CLASS, 'hidden md:table-cell')}>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-snug type-data text-oct-muted hover:text-oct-text transition-colors duration-fast max-w-[220px]"
          title={wallet.address}
        >
          <span className="truncate">{truncateAddress(wallet.address, 8, 6)}</span>
          {copied ? (
            <Check size={12} className="text-oct-good shrink-0" />
          ) : (
            <Copy size={12} className="shrink-0 opacity-0 group-hover:opacity-100" />
          )}
        </button>
      </td>
      <td className={TD_CLASS}>
        {/* Chain colour is per-chain brand data (from CHAIN_META), not a status — inline style is correct here. */}
        <span
          className="inline-flex px-snug py-hair rounded-oct-sm type-caption font-bold uppercase tracking-wide"
          style={{ color: chain.color, backgroundColor: `${chain.color}18` }}
        >
          {chain.short}
        </span>
      </td>
      <td className={cn(TD_CLASS, 'hidden lg:table-cell')}>
        <div className="flex items-center gap-cozy text-oct-muted">
          <AlertIcon active={wallet.alerts_on_toast} icon={Bell} title="Toast" />
          <AlertIcon active={wallet.alerts_on_feed} icon={Rss} title="Feed" />
          <AlertIcon active={wallet.alerts_on_bubble} icon={CircleDot} title="Bubble" />
        </div>
      </td>
      <td className={TD_CLASS}>
        <div className="flex items-center justify-end gap-tight">
          <button
            type="button"
            onClick={onEdit}
            className="p-snug rounded-oct-sm text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors duration-fast"
            title="Edit"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="p-snug rounded-oct-sm text-oct-muted hover:text-oct-critical hover:bg-oct-critical-dim transition-colors duration-fast"
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
