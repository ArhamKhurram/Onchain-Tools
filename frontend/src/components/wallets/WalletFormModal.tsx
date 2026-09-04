import { useEffect, useRef, useState } from 'react';
import { PRESET_SOUNDS } from '../../utils/notificationSound';
import type { TrackedWallet, TrackedWalletInsert, WalletChain } from '../../types/wallets';
import { validateWalletAddress, WALLET_CHAINS } from '../../types/wallets';
import { cn } from '../../lib/utils';
import WalletModalShell, {
  chainButtonClass,
  FIELD_CLASS,
  FIELD_ERROR_CLASS,
  LABEL_CLASS,
} from './WalletModalShell';

export type WalletFormValues = TrackedWalletInsert;

const CHAIN_OPTIONS = WALLET_CHAINS.filter((c) => c.value !== 'all') as { value: WalletChain; label: string }[];

const DEFAULT_VALUES: WalletFormValues = {
  address: '',
  chain: 'ethereum',
  name: '',
  emoji: '',
  profile: 'unclassified',
  alerts_on_toast: true,
  alerts_on_feed: true,
  alerts_on_bubble: true,
  sound: 'default',
};

function walletToForm(wallet: TrackedWallet): WalletFormValues {
  return {
    address: wallet.address,
    chain: wallet.chain,
    name: wallet.name,
    emoji: wallet.emoji,
    profile: wallet.profile,
    alerts_on_toast: wallet.alerts_on_toast,
    alerts_on_feed: wallet.alerts_on_feed,
    alerts_on_bubble: wallet.alerts_on_bubble,
    sound: wallet.sound,
  };
}

interface WalletFormModalProps {
  open: boolean;
  mode: 'add' | 'edit';
  wallet?: TrackedWallet | null;
  onClose: () => void;
  onSubmit: (values: WalletFormValues) => Promise<void>;
}

export default function WalletFormModal({ open, mode, wallet, onClose, onSubmit }: WalletFormModalProps) {
  const [values, setValues] = useState<WalletFormValues>(DEFAULT_VALUES);
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
        name: values.name.trim(),
        emoji: values.emoji.trim(),
        profile: values.profile.trim() || 'unclassified',
      });
      onClose();
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : 'Failed to save wallet');
    } finally {
      setSubmitting(false);
    }
  };

  const set = <K extends keyof WalletFormValues>(key: K, val: WalletFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    if (key === 'address' || key === 'chain') setFieldError(null);
  };

  return (
    <WalletModalShell
      open={open}
      title={mode === 'add' ? 'Add wallet' : 'Edit wallet'}
      busy={submitting}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="px-roomy py-comfy space-y-comfy max-h-[70vh] overflow-y-auto">
        <div>
          <span className={LABEL_CLASS}>Chain</span>
          <div className="flex gap-snug">
            {CHAIN_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => set('chain', value)}
                className={cn('flex-1', chainButtonClass(values.chain === value))}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="wallet-address" className={LABEL_CLASS}>
            Address
          </label>
          <input
            ref={addressRef}
            id="wallet-address"
            type="text"
            value={values.address}
            onChange={(e) => set('address', e.target.value)}
            placeholder={values.chain === 'solana' ? 'Base58 address…' : '0x…'}
            disabled={mode === 'edit'}
            spellCheck={false}
            className={cn(FIELD_CLASS, 'type-data text-sm disabled:opacity-60 disabled:cursor-not-allowed')}
          />
        </div>

        <div className="grid grid-cols-[4rem_1fr] gap-comfy">
          <div>
            <label htmlFor="wallet-emoji" className={LABEL_CLASS}>
              Emoji
            </label>
            <input
              id="wallet-emoji"
              type="text"
              maxLength={4}
              value={values.emoji}
              onChange={(e) => set('emoji', e.target.value)}
              placeholder="🐋"
              className={cn(FIELD_CLASS, 'text-center')}
            />
          </div>
          <div>
            <label htmlFor="wallet-name" className={LABEL_CLASS}>
              Label <span className="normal-case font-normal text-oct-muted/70">(optional)</span>
            </label>
            <input
              id="wallet-name"
              type="text"
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Whale wallet"
              className={FIELD_CLASS}
            />
          </div>
        </div>

        <div>
          <label htmlFor="wallet-profile" className={LABEL_CLASS}>
            Profile
          </label>
          <input
            id="wallet-profile"
            type="text"
            value={values.profile}
            onChange={(e) => set('profile', e.target.value)}
            placeholder="unclassified"
            className={FIELD_CLASS}
          />
        </div>

        <div>
          <span className={LABEL_CLASS}>Alerts</span>
          <div className="flex flex-wrap gap-comfy">
            {(
              [
                ['alerts_on_toast', 'Toast'],
                ['alerts_on_feed', 'Feed'],
                ['alerts_on_bubble', 'Bubble'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-snug type-body text-oct-text cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={values[key]}
                  onChange={(e) => set(key, e.target.checked)}
                  className="rounded border-oct-border bg-oct-bg text-oct-accent focus:ring-oct-accent focus:ring-offset-0"
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="wallet-sound" className={LABEL_CLASS}>
            Sound
          </label>
          <select
            id="wallet-sound"
            value={values.sound}
            onChange={(e) => set('sound', e.target.value)}
            className={FIELD_CLASS}
          >
            <option value="default">Default</option>
            {PRESET_SOUNDS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
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
