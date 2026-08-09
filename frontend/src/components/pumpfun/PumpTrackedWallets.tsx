import { useEffect, useState } from 'react';
import { Plus, Users, X } from 'lucide-react';
import type { useTrackedPumpWallets } from '../../hooks/useTrackedPumpWallets';
import { usePumpWalletNames } from '../../hooks/usePumpWalletNames';
import { isPumpWallet, truncateAddress } from '../../types/pumpfun';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import PumpWalletPanel from './PumpWalletPanel';

interface PumpTrackedWalletsProps {
  tracking: ReturnType<typeof useTrackedPumpWallets>;
}

// The tracked-trader tab: a paste-to-track form, the persisted list (localStorage
// via the hook), and the activity panel for whichever wallet is selected. The
// list drives selection; adding a wallet selects it so its activity loads at
// once.
export default function PumpTrackedWallets({ tracking }: PumpTrackedWalletsProps) {
  const { wallets, track, untrack } = tracking;
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(wallets[0]?.address ?? null);
  // Resolve each tracked wallet's pump.fun handle so the list reads as names, not
  // raw addresses. Cached per address (one fetch each), so this does not refire as
  // the list re-renders or selection changes.
  const names = usePumpWalletNames(wallets.map((w) => w.address));

  // Keep a valid selection as the list changes: default to the first wallet, and
  // drop the selection if the selected wallet was untracked.
  useEffect(() => {
    if (selected && !wallets.some((w) => w.address === selected)) {
      setSelected(wallets[0]?.address ?? null);
    } else if (!selected && wallets.length > 0) {
      setSelected(wallets[0].address);
    }
  }, [wallets, selected]);

  const submit = () => {
    const address = input.trim();
    const result = track(address);
    if (result.ok) {
      setSelected(address);
      setInput('');
      setNotice(null);
    } else {
      setNotice(result.reason === 'duplicate' ? 'Already tracking that wallet.' : 'Not a valid Solana wallet address.');
    }
  };

  const inputValid = input.trim() === '' || isPumpWallet(input);

  return (
    <div className="h-full min-h-0 flex flex-col md:flex-row bg-oct-bg">
      {/* Left: add form + tracked list. */}
      <div className="md:w-72 shrink-0 flex flex-col border-b md:border-b-0 md:border-r border-oct-border bg-oct-surface/40 min-h-0">
        <div className="px-3 py-3 border-b border-oct-border">
          <div className="flex items-center gap-1.5">
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setNotice(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Paste a wallet address"
              spellCheck={false}
              className={`oct-input flex-1 min-w-0 px-2.5 py-2 font-mono text-xs ${
                inputValid ? '' : '!border-oct-flame'
              }`}
            />
            <button
              type="button"
              onClick={submit}
              disabled={input.trim() === '' || !isPumpWallet(input)}
              className="flex items-center justify-center w-9 h-9 shrink-0 rounded-oct-sm border border-oct-accent/60 text-oct-accent hover:bg-oct-accent hover:text-white hover:shadow-oct-glow-accent disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-oct-accent disabled:hover:shadow-none transition-all"
              title="Track this wallet"
            >
              <Plus size={16} />
            </button>
          </div>
          {notice && <p className="mt-1.5 font-mono text-[11px] text-oct-flame">{notice}</p>}
          <p className="mt-1.5 font-mono text-[11px] text-oct-muted/80 leading-relaxed">
            Tracking is saved in this browser only (no account sync yet).
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {wallets.length === 0 ? (
            <p className="px-3 py-4 font-mono text-xs text-oct-muted">No wallets tracked yet.</p>
          ) : (
            wallets.map((w) => (
              <div
                key={w.address}
                className={`group flex items-center gap-2 px-3 py-2.5 border-b border-oct-border/40 cursor-pointer transition-colors ${
                  selected === w.address ? 'bg-oct-accent-dim border-l-2 border-l-oct-accent' : 'hover:bg-oct-surface-raised/50'
                }`}
                onClick={() => setSelected(w.address)}
              >
                <span
                  className={`flex-1 min-w-0 font-mono text-[13px] truncate ${
                    selected === w.address ? 'text-oct-accent font-semibold' : 'text-oct-text'
                  }`}
                  title={w.address}
                >
                  {/* Name once resolved; the truncated address until then, and if it
                      never resolves (KEYED profile host off, or no pump identity). */}
                  {names[w.address] ?? truncateAddress(w.address)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    untrack(w.address);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-oct-muted hover:text-oct-flame transition-opacity shrink-0"
                  title="Untrack"
                >
                  <X size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right: the selected wallet's activity. */}
      <div className="flex-1 min-h-0">
        {selected ? (
          <PumpWalletPanel key={selected} address={selected} />
        ) : (
          <ConsoleEmptyState
            icon={Users}
            eyebrow="[ PUMP.FUN · TRADERS ]"
            title="Track a pump.fun trader"
            description="Paste a Solana wallet to follow their callouts and trades. Trades and PnL work without an API key; callouts need one."
            actionLabel="—"
          />
        )}
      </div>
    </div>
  );
}
