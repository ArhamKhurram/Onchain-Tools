import type { HoldingWallet } from '../../types/holdingWallets';
import { truncateAddress } from '../../types/wallets';
import { isEvmWalletChain } from '../../types/portfolio';
import { CHAIN_META } from '../../types/wallets';
import { PORTFOLIO_ALL_WALLETS } from '../../hooks/usePortfolio';

interface PortfolioWalletPickerProps {
  wallets: HoldingWallet[];
  selectedId: string;
  onChange: (id: string) => void;
}

export default function PortfolioWalletPicker({
  wallets,
  selectedId,
  onChange,
}: PortfolioWalletPickerProps) {
  const showAll = wallets.length > 1;

  return (
    <label className="flex flex-col gap-1.5 min-w-[220px]">
      <span className="oct-eyebrow">My Wallet</span>
      <select
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        className="oct-input font-mono text-xs px-3 py-2"
      >
        {showAll && (
          <option value={PORTFOLIO_ALL_WALLETS}>All Wallets ({wallets.length})</option>
        )}
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
