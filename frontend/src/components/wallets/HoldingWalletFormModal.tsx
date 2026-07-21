import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { HoldingWallet, HoldingWalletInsert } from '../../types/holdingWallets';
import type { WalletChain } from '../../types/wallets';
import { validateWalletAddress, WALLET_CHAINS } from '../../types/wallets';

export type HoldingWalletFormValues = HoldingWalletInsert;

const CHAIN_OPTIONS = WALLET_CHAINS.filter((c) => c.value !== 'all') as { value: WalletChain; label: string }[];

const DEFAULT_VALUES: HoldingWalletFormValues = {
  address: '',
  chain: 'solana',
  label: '',
};

function walletToForm(wallet: HoldingWallet): HoldingWalletFormValues {
  return {
    address: wallet.address,
    chain: wallet.chain,
    label: wallet.label,
  };
}

interface HoldingWalletFormModalProps {
  open: boolean;
  mode: 'add' | 'edit';
  wallet?: HoldingWallet | null;
  onClose: () => void;
  onSubmit: (values: HoldingWalletFormValues) => Promise<void>;
}

export default function HoldingWalletFormModal({
  open,
  mode,
  wallet,
  onClose,
  onSubmit,
}: HoldingWalletFormModalProps) {
  const [values, setValues] = useState<HoldingWalletFormValues>(DEFAULT_VALUES);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValues(mode === 'edit' && wallet ? walletToForm(wallet) : DEFAULT_VALUES);
    setFieldError(null);
    setSubmitting(false);
    setTimeout(() => addressRef.current?.focus(), 50);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addrError = validateWalletAddress(values.address, values.chain);
    if (addrError) {
      setFieldError(addrError);
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        ...values,
        address: values.address.trim(),
        label: values.label.trim(),
      });
      onClose();
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : 'Failed to save wallet');
    } finally {
      setSubmitting(false);
    }
  };

  const set = <K extends keyof HoldingWalletFormValues>(key: K, val: HoldingWalletFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    if (key === 'address' || key === 'chain') setFieldError(null);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" onClick={() => !submitting && onClose()}>
      <div
        className="w-full max-w-lg rounded-cockpit border-2 border-black bg-oct-surface shadow-oct-hard-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-black">
          <h3 className="text-base font-extrabold uppercase text-oct-text">
            {mode === 'add' ? 'Add my wallet' : 'Edit wallet'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="p-1.5 rounded-md text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          <p className="text-xs text-oct-muted leading-relaxed">
            Addresses you buy from. Used for missed-runner alerts — not shared with whale tracking.
          </p>

          <div>
            <label className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">Chain</label>
            <div className="flex flex-wrap gap-2">
              {CHAIN_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => set('chain', value)}
                  className={`px-3 py-2 rounded-cockpit text-xs font-bold uppercase border-2 transition-colors ${
                    values.chain === value
                      ? 'border-black bg-oct-accent text-white'
                      : 'border-oct-border text-oct-muted hover:border-oct-border-bright hover:text-oct-text'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="holding-wallet-address" className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">
              Address
            </label>
            <input
              ref={addressRef}
              id="holding-wallet-address"
              type="text"
              value={values.address}
              onChange={(e) => set('address', e.target.value)}
              placeholder={values.chain === 'solana' ? 'Base58 address…' : '0x…'}
              disabled={mode === 'edit'}
              className="w-full px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm font-mono text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label htmlFor="holding-wallet-label" className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">
              Label <span className="normal-case text-oct-muted/70">(optional)</span>
            </label>
            <input
              id="holding-wallet-label"
              type="text"
              value={values.label}
              onChange={(e) => set('label', e.target.value)}
              placeholder="Main SOL wallet"
              className="w-full px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
            />
          </div>

          {fieldError && (
            <p className="text-sm text-oct-accent bg-oct-accent-dim border-2 border-oct-accent rounded-cockpit px-3 py-2">
              {fieldError}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={submitting} className="brutal-btn-ghost px-4 py-2 text-sm">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="brutal-btn px-4 py-2 text-sm">
              {submitting ? 'Saving…' : mode === 'add' ? 'Add wallet' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
