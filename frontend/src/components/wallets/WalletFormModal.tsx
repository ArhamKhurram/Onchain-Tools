import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { PRESET_SOUNDS } from '../../utils/notificationSound';
import type { TrackedWallet, TrackedWalletInsert, WalletChain } from '../../types/wallets';
import { validateWalletAddress, WALLET_CHAINS } from '../../types/wallets';

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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" onClick={() => !submitting && onClose()}>
      <div
        className="w-full max-w-lg rounded-cockpit border-2 border-black bg-oct-surface shadow-oct-hard-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-black">
          <h3 className="text-base font-extrabold uppercase text-oct-text">
            {mode === 'add' ? 'Add wallet' : 'Edit wallet'}
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

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">Chain</label>
            <div className="flex gap-2">
              {CHAIN_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => set('chain', value)}
                  className={`flex-1 px-3 py-2 rounded-cockpit text-xs font-bold uppercase border-2 transition-colors ${
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
            <label htmlFor="wallet-address" className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">
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
              className="w-full px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm font-mono text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          <div className="grid grid-cols-[4rem_1fr] gap-3">
            <div>
              <label htmlFor="wallet-emoji" className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">
                Emoji
              </label>
              <input
                id="wallet-emoji"
                type="text"
                maxLength={4}
                value={values.emoji}
                onChange={(e) => set('emoji', e.target.value)}
                placeholder="🐋"
                className="w-full px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-center text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
              />
            </div>
            <div>
              <label htmlFor="wallet-name" className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">
                Label <span className="normal-case text-oct-muted/70">(optional)</span>
              </label>
              <input
                id="wallet-name"
                type="text"
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Whale wallet"
                className="w-full px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
              />
            </div>
          </div>

          <div>
            <label htmlFor="wallet-profile" className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">
              Profile
            </label>
            <input
              id="wallet-profile"
              type="text"
              value={values.profile}
              onChange={(e) => set('profile', e.target.value)}
              placeholder="unclassified"
              className="w-full px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
            />
          </div>

          <div>
            <span className="block text-xs font-medium text-oct-muted mb-2 uppercase tracking-wide">Alerts</span>
            <div className="flex flex-wrap gap-3">
              {(
                [
                  ['alerts_on_toast', 'Toast'],
                  ['alerts_on_feed', 'Feed'],
                  ['alerts_on_bubble', 'Bubble'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm text-oct-text cursor-pointer select-none">
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
            <label htmlFor="wallet-sound" className="block text-xs font-medium text-oct-muted mb-1.5 uppercase tracking-wide">
              Sound
            </label>
            <select
              id="wallet-sound"
              value={values.sound}
              onChange={(e) => set('sound', e.target.value)}
              className="w-full px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text focus:outline-none focus:border-oct-accent"
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
            <p className="text-sm text-oct-accent bg-oct-accent-dim border-2 border-oct-accent rounded-cockpit px-3 py-2">
              {fieldError}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="brutal-btn-ghost px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="brutal-btn px-4 py-2 text-sm"
            >
              {submitting ? 'Saving…' : mode === 'add' ? 'Add wallet' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
