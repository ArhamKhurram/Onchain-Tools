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
    <label className="flex flex-col gap-1 min-w-[220px]">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-accent/80">My Wallet</span>
      <select
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs bg-black border-2 border-oct-accent/40 px-3 py-2 text-white focus:outline-none focus:border-oct-accent"
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
