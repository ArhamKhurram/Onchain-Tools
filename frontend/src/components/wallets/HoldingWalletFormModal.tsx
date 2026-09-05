import { useEffect, useRef, useState } from 'react';
import type { HoldingWallet, HoldingWalletInsert } from '../../types/holdingWallets';
import type { WalletChain } from '../../types/wallets';
import { validateWalletAddress, WALLET_CHAINS } from '../../types/wallets';
import { cn } from '../../lib/utils';
import WalletModalShell, {
  chainButtonClass,
  FIELD_CLASS,
  FIELD_ERROR_CLASS,
  LABEL_CLASS,
} from './WalletModalShell';

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
    <WalletModalShell
      open={open}
      title={mode === 'add' ? 'Add my wallet' : 'Edit wallet'}
      busy={submitting}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="px-roomy py-comfy space-y-comfy">
        <p className="type-caption text-oct-muted leading-relaxed">
          Addresses you buy from. Used for missed-runner alerts — not shared with whale tracking.
        </p>

        <div>
          <span className={LABEL_CLASS}>Chain</span>
          <div className="flex flex-wrap gap-snug">
            {CHAIN_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => set('chain', value)}
                className={chainButtonClass(values.chain === value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="holding-wallet-address" className={LABEL_CLASS}>
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
            spellCheck={false}
            className={cn(FIELD_CLASS, 'type-data text-sm disabled:opacity-60 disabled:cursor-not-allowed')}
          />
        </div>

        <div>
          <label htmlFor="holding-wallet-label" className={LABEL_CLASS}>
            Label <span className="normal-case font-normal text-oct-muted/70">(optional)</span>
          </label>
          <input
            id="holding-wallet-label"
            type="text"
            value={values.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="Main SOL wallet"
            className={FIELD_CLASS}
          />
        </div>

        {fieldError && (
          <p role="alert" className={FIELD_ERROR_CLASS}>
            {fieldError}
          </p>
        )}

        <div className="flex justify-end gap-cozy pt-tight">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="oct-icon-btn px-comfy py-snug type-label"
          >
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="oct-btn-primary px-comfy py-snug type-label">
            {submitting ? 'Saving…' : mode === 'add' ? 'Add wallet' : 'Save changes'}
          </button>
        </div>
      </form>
    </WalletModalShell>
  );
}
