import type { HoldingWallet } from '../../types/holdingWallets';
import { CHAIN_META, truncateAddress } from '../../types/wallets';
import { isEvmWalletChain } from '../../types/portfolio';

interface PortfolioWalletPickerProps {
  wallets: HoldingWallet[];
  selectedId: string | null;
  onChange: (id: string) => void;
}

export default function PortfolioWalletPicker({
  wallets,
  selectedId,
  onChange,
}: PortfolioWalletPickerProps) {
  return (
    <label className="flex flex-col gap-1 min-w-[220px]">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted">My Wallet</span>
      <select
        value={selectedId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs bg-oct-surface border-2 border-black px-3 py-2 text-oct-text focus:outline-none focus:border-oct-accent"
      >
        {wallets.map((w) => {
          const short = isEvmWalletChain(w.chain) ? 'EVM' : CHAIN_META[w.chain].short;
          const label = w.label.trim() || truncateAddress(w.address);
          return (
            <option key={w.id} value={w.id}>
              [{short}] {label}
            </option>
          );
        })}
      </select>
    </label>
  );
}
