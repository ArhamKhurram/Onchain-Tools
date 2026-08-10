import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { isSolAddress, type SniperWallet } from '../../types/sniper';
import type { SniperWalletDraft } from '../../hooks/useSniperWallets';
import { useVenueWallets } from '../../hooks/useVenueWallets';

const DEFAULTS: SniperWalletDraft = {
  label: '',
  chain: 'sol',
  venue: 'slotshark',
  address: '',
  unit: 'SOL',
  perFireCap: 0.1,
  dailyCap: 1,
  maxOpen: 3,
};

const FIELD =
  'oct-input w-full px-3 py-2 text-sm font-mono disabled:opacity-60 disabled:cursor-not-allowed';
const LABEL = 'block oct-label text-oct-muted mb-1.5 uppercase tracking-wide';

interface SniperWalletFormModalProps {
  open: boolean;
  mode: 'add' | 'edit';
  wallet?: SniperWallet | null;
  onClose: () => void;
  onSubmit: (values: SniperWalletDraft) => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
}

export default function SniperWalletFormModal({ open, mode, wallet, onClose, onSubmit }: SniperWalletFormModalProps) {
  const [values, setValues] = useState<SniperWalletDraft>(DEFAULTS);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const venueWallets = useVenueWallets();

  /**
   * Task accounts are a pool of concurrent in-flight transactions — one per
   * transaction, released on confirmation (confirmed with the venue
   * 2026-08-08). Sells draw from the same pool, so `maxOpen` at or above the
   * count leaves an exit nothing to run on at the exact moment several
   * positions want out together.
   *
   * Warned at two thresholds because the two failures differ in cost: at or
   * over the count OCT can authorize a buy the venue cannot execute (it times
   * out, records `unknown`, and holds its reservation); below that but without
   * headroom, entries are fine and it is the exits that get starved.
   *
   * A warning, not a block: the count changes whenever the operator deploys
   * more, and this value is only as fresh as the last import.
   */
  const picked = venueWallets.wallets.find((w) => w.pubkey === values.address.trim());
  const capacity = picked && picked.nonceCount >= 0 ? picked.nonceCount : null;
  const overCapacity = capacity !== null && values.maxOpen >= capacity;
  const thinHeadroom = capacity !== null && !overCapacity && values.maxOpen * 2 > capacity;

  useEffect(() => {
    if (!open) return;
    setValues(
      mode === 'edit' && wallet
        ? {
            label: wallet.label,
            chain: wallet.chain,
            venue: wallet.venue,
            address: wallet.address,
            unit: wallet.unit,
            perFireCap: wallet.perFireCap,
            dailyCap: wallet.dailyCap,
            maxOpen: wallet.maxOpen,
          }
        : DEFAULTS,
    );
    setFieldError(null);
    setSubmitting(false);
    setPicking(false);
    setTimeout(() => labelRef.current?.focus(), 50);
  }, [open, mode, wallet]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const set = <K extends keyof SniperWalletDraft>(key: K, val: SniperWalletDraft[K]) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setFieldError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Same checks the API and the CHECK constraints make, in the same order and
    // with the same meaning, so the form refuses locally what the server would
    // refuse remotely rather than bouncing the operator off a 400.
    if (!isSolAddress(values.address)) {
      setFieldError('Invalid address (base58, 32–48 characters). Case matters — a lowercased key is a different wallet.');
      return;
    }
    if (!(values.perFireCap > 0) || !(values.dailyCap > 0) || !(values.maxOpen > 0)) {
      setFieldError('Caps must all be greater than zero.');
      return;
    }
    if (values.dailyCap < values.perFireCap) {
      setFieldError('Daily cap is below the per-fire cap, which would refuse every fire after the first.');
      return;
    }

    setSubmitting(true);
    const res = await onSubmit({ ...values, address: values.address.trim(), label: values.label.trim() });
    setSubmitting(false);
    if (res.ok) onClose();
    else setFieldError(res.detail ? `${res.reason} — ${res.detail}` : res.reason);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="w-full max-w-lg oct-card oct-card-flush shadow-oct-soft-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="oct-headerbar flex items-center justify-between px-5 py-4">
          <h3 className="oct-section-title text-base uppercase">
            {mode === 'add' ? 'Add sniper wallet' : 'Edit sniper wallet'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="oct-icon-btn p-1.5 disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-oct-muted leading-relaxed">
            The venue holds this wallet and its keys — OCT holds nothing for it. The address below is the venue-side
            pubkey a buy is placed from.
          </p>

          <div>
            <label htmlFor="sniper-wallet-label" className={LABEL}>
              Label
            </label>
            <input
              ref={labelRef}
              id="sniper-wallet-label"
              type="text"
              value={values.label}
              onChange={(e) => set('label', e.target.value)}
              placeholder="Slotshark main"
              className={FIELD}
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label htmlFor="sniper-wallet-address" className={`${LABEL} mb-0`}>
                Venue wallet address
              </label>
              {mode === 'add' && (
                <button
                  type="button"
                  onClick={() => {
                    setPicking((p) => !p);
                    if (venueWallets.wallets.length === 0) void venueWallets.load(values.venue);
                  }}
                  className="text-xs font-mono uppercase tracking-wide text-oct-accent hover:underline disabled:opacity-50"
                  disabled={submitting}
                >
                  {picking ? 'Cancel' : 'Import from Slotshark'}
                </button>
              )}
            </div>

            {picking && (
              <div className="mb-2 border border-oct-border rounded-oct bg-oct-bg divide-y divide-oct-border overflow-hidden">
                {venueWallets.loading && <p className="px-3 py-2 text-xs text-oct-muted">Loading…</p>}
                {venueWallets.error && <p className="px-3 py-2 text-xs text-oct-flame">{venueWallets.error}</p>}
                {!venueWallets.loading && !venueWallets.error && venueWallets.wallets.length === 0 && (
                  <p className="px-3 py-2 text-xs text-oct-muted">No wallets on the venue.</p>
                )}
                {venueWallets.wallets.map((w) => (
                  <button
                    key={w.pubkey}
                    type="button"
                    disabled={w.imported}
                    onClick={() => {
                      setValues((v) => ({ ...v, address: w.pubkey, label: v.label || w.label }));
                      setPicking(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-oct-surface-raised disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="font-mono text-sm text-oct-text">{w.label || 'Unlabelled'}</span>
                    <span className="block font-mono text-[11px] text-oct-muted truncate">{w.pubkey}</span>
                    <span className="block font-mono text-[11px] text-oct-muted">
                      {w.balanceSol === null ? 'balance unavailable' : `${w.balanceSol} SOL`}
                      {' · '}
                      {w.nonceCount < 0 ? 'task accounts unknown' : `${w.nonceCount} task accounts`}
                      {!w.enabled && ' · DISABLED AT VENUE'}
                      {w.imported && ' · already added'}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <input
              id="sniper-wallet-address"
              type="text"
              value={values.address}
              onChange={(e) => set('address', e.target.value)}
              placeholder="Base58 address…"
              className={FIELD}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sniper-wallet-chain" className={LABEL}>
                Chain {mode === 'edit' && <span className="normal-case text-oct-muted/70">(immutable)</span>}
              </label>
              {/* Chain and venue are immutable after creation: both key the
                  wallet's budget rows, so changing either would orphan today's
                  spend and silently reset it to zero. */}
              <select
                id="sniper-wallet-chain"
                value={values.chain}
                disabled={mode === 'edit'}
                onChange={(e) => set('chain', e.target.value as SniperWalletDraft['chain'])}
                className={FIELD}
              >
                <option value="sol">sol</option>
              </select>
            </div>
            <div>
              <label htmlFor="sniper-wallet-unit" className={LABEL}>
                Unit
              </label>
              <select
                id="sniper-wallet-unit"
                value={values.unit}
                onChange={(e) => set('unit', e.target.value as SniperWalletDraft['unit'])}
                className={FIELD}
              >
                <option value="SOL">SOL</option>
                <option value="USDC">USDC</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="sniper-wallet-perfire" className={LABEL}>
                Per-fire cap
              </label>
              <input
                id="sniper-wallet-perfire"
                type="number"
                step="any"
                min="0"
                value={values.perFireCap}
                onChange={(e) => set('perFireCap', Number(e.target.value))}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="sniper-wallet-daily" className={LABEL}>
                Daily cap
              </label>
              <input
                id="sniper-wallet-daily"
                type="number"
                step="any"
                min="0"
                value={values.dailyCap}
                onChange={(e) => set('dailyCap', Number(e.target.value))}
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="sniper-wallet-maxopen" className={LABEL}>
                Max open
              </label>
              <input
                id="sniper-wallet-maxopen"
                type="number"
                step="1"
                min="1"
                value={values.maxOpen}
                onChange={(e) => set('maxOpen', Number(e.target.value))}
                className={FIELD}
              />
            </div>
          </div>

          {capacity !== null && (overCapacity || thinHeadroom) && (
            <p className="text-xs text-oct-yellow leading-relaxed">
              This wallet has <span className="font-mono">{capacity}</span> task accounts at Slotshark — a pool of{' '}
              {capacity} transactions in flight at once, and{' '}
              <span className="font-semibold">sells draw from it too</span>.
              {overCapacity ? (
                <>
                  {' '}
                  A max open of <span className="font-mono">{values.maxOpen}</span> can consume the whole pool, leaving
                  an exit nothing to run on — and letting OCT authorize a buy the venue cannot execute, which times
                  out, records as <span className="font-mono">unknown</span> and holds its reservation until you
                  resolve it.
                </>
              ) : (
                <>
                  {' '}
                  With <span className="font-mono">{values.maxOpen}</span> open, a moment where they all want out at
                  once needs {values.maxOpen} more than the entries already used.
                </>
              )}{' '}
              Failing to enter costs an opportunity; failing to exit costs the position. Lower this, or deploy more
              task accounts at Slotshark.
            </p>
          )}

          {/* The two directions are NOT symmetric, and saying so is the point:
              a raise is deferred so it cannot re-authorise a fire today's budget
              already refused, while a reduction binds immediately because it can
              only refuse fires that have not happened yet. */}
          <p className="text-[11px] text-oct-muted leading-relaxed">
            Caps are snapshotted into each UTC day&rsquo;s budget row when that day&rsquo;s first fire happens.{' '}
            <span className="text-oct-text font-medium">Lowering a cap applies immediately</span>, including to today&rsquo;s
            row. Raising one does not — it takes effect tomorrow, or on a wallet that has not fired yet today.
          </p>

          {fieldError && (
            <p className="text-sm text-oct-flame bg-oct-flame/10 border border-oct-flame/50 rounded-oct px-3 py-2 font-mono">
              {fieldError}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={submitting} className="oct-icon-btn px-4 py-2 text-sm">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="oct-btn-primary px-4 py-2 text-sm">
              {submitting ? 'Saving…' : mode === 'add' ? 'Add wallet' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
