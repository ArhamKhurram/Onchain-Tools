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
    <label className="flex flex-col gap-tight min-w-[220px]">
      <span className="type-caption font-mono uppercase tracking-[0.14em] text-oct-muted">My Wallet</span>
      {/* Options are `[CHAIN] label-or-address` — the address case wants
          slashed zeros and tabular digits, hence `type-data` on the control. */}
      <select
        value={selectedId}
        onChange={(e) => onChange(e.target.value)}
        className="oct-input type-data px-comfy py-snug"
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
