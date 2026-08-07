import { useState } from 'react';
import { Plus, Wallet } from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import SniperWalletFormModal from './SniperWalletFormModal';
import { truncateAddress } from '../../types/wallets';
import type { SniperWallet } from '../../types/sniper';
import type { useSniperWallets } from '../../hooks/useSniperWallets';

const TH = 'px-3 py-2 font-medium';

interface SniperWalletsTableProps {
  wallets: ReturnType<typeof useSniperWallets>;
}

export default function SniperWalletsTable({ wallets }: SniperWalletsTableProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SniperWallet | null>(null);
  const [deleting, setDeleting] = useState<SniperWallet | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const budgetFor = (walletId: string) => wallets.budget.find((b) => b.walletId === walletId);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const res = await wallets.deleteWallet(deleting.walletId);
    setDeleting(null);
    if (!res.ok) {
      // 409 wallet_in_use is the common case and the operator can act on it:
      // detach the wallet from its rules first.
      setNotice(
        res.reason === 'wallet_in_use'
          ? 'That wallet is referenced by a rule. Remove it from the rule first.'
          : res.reason,
      );
    }
  };

  if (!wallets.loading && wallets.wallets.length === 0) {
    return (
      <>
        <ConsoleEmptyState
          icon={Wallet}
          eyebrow="[ SNIPER · WALLETS ]"
          title="No sniper wallets"
          description="A sniper wallet is a venue-held wallet plus the caps that bound it — per fire, per day, and how many positions may be open at once."
          actionLabel="ADD WALLET"
          onActionClick={openAdd}
        />
        <SniperWalletFormModal
          open={formOpen}
          mode="add"
          onClose={() => setFormOpen(false)}
          onSubmit={wallets.createWallet}
        />
      </>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b-2 border-black bg-oct-surface">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-oct-muted">view: wallets</span>
        <div className="flex-1" />
        {notice && <span className="font-mono text-[11px] text-oct-flame">{notice}</span>}
        <span className="font-mono text-[11px] text-oct-muted">{wallets.wallets.length} wallets</span>
        <button
          type="button"
          onClick={openAdd}
          className="flex items-center gap-1.5 px-2 py-1 rounded-cockpit text-xs font-bold uppercase text-oct-muted hover:text-oct-text border-2 border-oct-border-bright hover:border-oct-text transition-colors"
        >
          <Plus size={12} />
          add
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[900px]">
          <thead className="sticky top-0 bg-oct-surface border-b-2 border-black z-10">
            <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
              <th className={TH}>Label</th>
              <th className={TH}>Venue</th>
              <th className={TH}>Chain</th>
              <th className={TH}>Address</th>
              <th className={TH}>Unit</th>
              <th className={`${TH} text-right`}>Per fire</th>
              <th className={`${TH} text-right`}>Today / daily</th>
              <th className={`${TH} text-right`}>Open / max</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {wallets.wallets.map((w) => {
              const b = budgetFor(w.walletId);
              return (
                <tr key={w.walletId} className="border-b border-oct-border/50 hover:bg-oct-surface-raised/50 transition-colors">
                  <td className="px-3 py-2 text-sm text-oct-text">{w.label || <span className="text-oct-muted">—</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs text-oct-muted">{w.venue}</td>
                  <td className="px-3 py-2 font-mono text-xs text-oct-muted">{w.chain}</td>
                  <td className="px-3 py-2 font-mono text-xs text-oct-text" title={w.address}>
                    {truncateAddress(w.address)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-oct-muted">{w.unit}</td>
                  <td className="px-3 py-2 font-mono text-xs text-oct-text text-right">{w.perFireCap}</td>
                  <td className="px-3 py-2 font-mono text-xs text-oct-text text-right">
                    {(b?.spentToday ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} / {b?.dailyCap ?? w.dailyCap}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-oct-text text-right">
                    {b?.openPositions ?? 0} / {b?.maxOpen ?? w.maxOpen}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(w);
                          setFormOpen(true);
                        }}
                        className="px-2 py-0.5 rounded-cockpit text-[10px] font-mono font-bold uppercase border-2 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright transition-colors"
                      >
                        edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleting(w)}
                        className="px-2 py-0.5 rounded-cockpit text-[10px] font-mono font-bold uppercase border-2 border-oct-border text-oct-muted hover:text-oct-accent hover:border-oct-accent transition-colors"
                      >
                        delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <SniperWalletFormModal
        open={formOpen}
        mode={editing ? 'edit' : 'add'}
        wallet={editing}
        onClose={() => setFormOpen(false)}
        onSubmit={(values) =>
          editing ? wallets.updateWallet(editing.walletId, values) : wallets.createWallet(values)
        }
      />

      <ConfirmModal
        open={!!deleting}
        title="Delete this wallet?"
        message={
          'Its budget rows go with it. The fire log does not — every row of money it moved survives with the wallet ' +
          'reference nulled out.'
        }
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
