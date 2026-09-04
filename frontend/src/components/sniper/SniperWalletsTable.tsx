import { useState } from 'react';
import { Plus, Wallet } from 'lucide-react';
import ConfirmModal from '../ConfirmModal';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import SniperWalletFormModal from './SniperWalletFormModal';
import { truncateAddress } from '../../types/wallets';
import type { SniperWallet } from '../../types/sniper';
import type { useSniperWallets } from '../../hooks/useSniperWallets';
import { cn } from '../../lib/utils';

const TH = 'px-comfy py-snug font-semibold';
const TD = 'px-comfy py-snug';
const ROW_BTN =
  'px-cozy py-hair rounded-oct-sm type-caption font-mono font-bold uppercase border border-oct-border text-oct-muted transition-colors';

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
      <div className="oct-headerbar shrink-0 flex items-center gap-comfy px-roomy py-cozy">
        <span className="oct-eyebrow">view: wallets</span>
        <div className="flex-1" />
        {notice && <span className="type-caption font-mono text-oct-critical">{notice}</span>}
        <span className="type-data text-oct-muted">{wallets.wallets.length} wallets</span>
        <button
          type="button"
          onClick={openAdd}
          className="oct-icon-btn flex items-center gap-snug px-cozy py-snug type-label uppercase"
        >
          <Plus size={12} />
          add
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[900px]">
          <thead className="oct-thead sticky top-0 z-10">
            <tr className="type-caption font-mono uppercase tracking-wider text-oct-muted">
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
              // Budget rows are the caps doing their job, so the two "used /
              // limit" cells carry the cap semantics: at the limit is
              // `critical` (the next fire is refused), past half is `warn`.
              const spent = b?.spentToday ?? 0;
              const daily = b?.dailyCap ?? w.dailyCap;
              const open = b?.openPositions ?? 0;
              const maxOpen = b?.maxOpen ?? w.maxOpen;
              const capTone = (used: number, cap: number) =>
                used >= cap ? 'text-oct-critical' : used * 2 >= cap ? 'text-oct-warn' : 'text-oct-text';
              return (
                <tr key={w.walletId} className="border-b border-oct-border/50 oct-row-hover">
                  <td className={`${TD} type-body text-oct-text`}>{w.label || <span className="text-oct-muted">—</span>}</td>
                  <td className={`${TD} type-data text-oct-muted`}>{w.venue}</td>
                  <td className={`${TD} type-data text-oct-muted`}>{w.chain}</td>
                  <td className={`${TD} type-data text-oct-text`} title={w.address}>
                    {truncateAddress(w.address)}
                  </td>
                  <td className={`${TD} type-data text-oct-muted`}>{w.unit}</td>
                  <td className={`${TD} type-data text-oct-text text-right`}>{w.perFireCap}</td>
                  <td className={cn(TD, 'type-data text-right', capTone(spent, daily))}>
                    {spent.toLocaleString(undefined, { maximumFractionDigits: 6 })} / {daily}
                  </td>
                  <td className={cn(TD, 'type-data text-right', capTone(open, maxOpen))}>
                    {open} / {maxOpen}
                  </td>
                  <td className={TD}>
                    <div className="flex items-center justify-end gap-snug">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(w);
                          setFormOpen(true);
                        }}
                        className={`${ROW_BTN} hover:text-oct-text hover:border-oct-border-bright`}
                      >
                        edit
                      </button>
                      {/* Destructive, so the hover previews `critical` — not the accent. */}
                      <button
                        type="button"
                        onClick={() => setDeleting(w)}
                        className={`${ROW_BTN} hover:text-oct-critical hover:border-oct-critical`}
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
