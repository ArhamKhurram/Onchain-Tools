// A looked-up trader's recent swaps and transfers.
//
// The Traders tab's profile card is built from fomo.family's *profile* record,
// whose address fields turn out to be platform-internal identifiers with no
// on-chain existence (see FomoTraderLookup). This list is the opposite: it is
// real, verifiable trading behaviour, which is what the tab is actually for —
// studying how another trader operates.
//
// Read-only and demand-driven; nothing here persists.

import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Download, Upload } from 'lucide-react';
import type {
  BotTraderActivityEntry,
  BotTraderActivityResponse,
  BotTraderSwap,
  BotTraderTransfer,
} from '@oct/shared';
import ChainIcon from '../common/ChainIcon';
import { useFomoTraderActivity } from '../../hooks/useFomoLookup';

function formatUsd(value: number | null): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${Math.round(abs).toLocaleString()}`;
  return `$${abs.toFixed(2)}`;
}

function formatAmount(value: number | null): string | null {
  if (value == null) return null;
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(abs).toLocaleString();
  if (abs >= 1) return abs.toFixed(2);
  return abs.toPrecision(3);
}

/** `3m` / `4h` / `12d` from an ISO timestamp. */
function age(at: string | null): string {
  if (!at) return '—';
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

function fullTime(at: string | null): string | undefined {
  if (!at) return undefined;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : undefined;
}

function shortAddress(address: string | null): string | null {
  if (!address) return null;
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Headline label for the traded token. fomo.family's activity payload
 * identifies tokens by address and only sometimes carries a symbol, so the
 * shortened address is the honest fallback rather than a placeholder — and it
 * still links out to the chain explorer.
 */
function tokenLabel(entry: BotTraderSwap | BotTraderTransfer): string {
  if (entry.tokenSymbol) return `$${entry.tokenSymbol.toUpperCase()}`;
  return shortAddress(entry.tokenAddress) ?? 'Unknown token';
}

function TokenLink({ entry }: { entry: BotTraderSwap | BotTraderTransfer }) {
  const label = tokenLabel(entry);
  const className = 'font-mono font-bold text-oct-text truncate';
  if (!entry.explorerUrl) {
    return (
      <span className={className} title={entry.tokenAddress ?? undefined}>
        {label}
      </span>
    );
  }
  return (
    <a
      href={entry.explorerUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={entry.tokenAddress ?? undefined}
      className={`${className} hover:text-oct-accent hover:underline`}
    >
      {label}
    </a>
  );
}

const SWAP_STYLE = {
  buy: { label: 'BUY', color: 'text-oct-green', Icon: ArrowUpRight },
  sell: { label: 'SELL', color: 'text-oct-flame', Icon: ArrowDownRight },
  swap: { label: 'SWAP', color: 'text-oct-muted', Icon: ArrowLeftRight },
} as const;

function SwapRow({ swap }: { swap: BotTraderSwap }) {
  const { label, color, Icon } = SWAP_STYLE[swap.direction];

  return (
    <li className="flex items-center gap-3 px-4 py-2.5 oct-row-hover">
      <span
        className={`inline-flex items-center gap-1 shrink-0 w-[68px] font-extrabold uppercase text-[12px] ${color}`}
      >
        <Icon size={13} strokeWidth={2.5} />
        {label}
      </span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 text-xs text-oct-muted">
        <ChainIcon networkId={swap.networkId} />
        <TokenLink entry={swap} />
        {swap.provider && (
          <span
            className="font-mono text-[10px] uppercase text-oct-muted/70 shrink-0"
            title="Routing venue fomo.family used"
          >
            {swap.provider}
          </span>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="text-[13px] font-mono font-bold text-oct-text tabular-nums">
          {formatUsd(swap.usdValue)}
        </div>
        <div
          className="text-[11px] text-oct-muted font-mono tabular-nums"
          title={fullTime(swap.at)}
        >
          {age(swap.at)}
        </div>
      </div>
    </li>
  );
}

function TransferRow({ transfer }: { transfer: BotTraderTransfer }) {
  const isDeposit = (transfer.transferType ?? '').toUpperCase() === 'DEPOSIT';
  const Icon = isDeposit ? Download : Upload;
  const amount = formatAmount(transfer.amount);

  return (
    <li className="flex items-center gap-3 px-4 py-2.5 oct-row-hover">
      <span className="inline-flex items-center gap-1 shrink-0 w-[68px] font-extrabold uppercase text-[12px] text-oct-muted">
        <Icon size={13} strokeWidth={2.5} />
        {transfer.transferType ?? 'MOVE'}
      </span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 text-xs text-oct-muted">
        <ChainIcon networkId={transfer.networkId} />
        <TokenLink entry={transfer} />
        {amount && <span className="font-mono tabular-nums shrink-0">{amount}</span>}
      </div>
      <div className="text-right shrink-0">
        <div className="text-[13px] font-mono font-bold text-oct-text tabular-nums">
          {formatUsd(transfer.usdValue)}
        </div>
        <div
          className="text-[11px] text-oct-muted font-mono tabular-nums"
          title={fullTime(transfer.at)}
        >
          {age(transfer.at)}
        </div>
      </div>
    </li>
  );
}

function entryKey(entry: BotTraderActivityEntry, idx: number): string {
  return entry.id ?? `${entry.kind}-${entry.at ?? ''}-${idx}`;
}

function SummaryLine({ data }: { data: BotTraderActivityResponse }) {
  const { swapCount, transferCount, buyUsd, sellUsd } = data.summary;
  const parts = [
    `${swapCount} swap${swapCount === 1 ? '' : 's'}`,
    `${transferCount} transfer${transferCount === 1 ? '' : 's'}`,
  ];

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[11px] text-oct-muted tabular-nums">
      <span>{parts.join(' · ')}</span>
      <span>
        <span className="text-oct-green font-bold">{formatUsd(buyUsd)}</span> bought /{' '}
        <span className="text-oct-flame font-bold">{formatUsd(sellUsd)}</span> sold
      </span>
    </div>
  );
}

export default function FomoTraderActivity({ fomoUserId }: { fomoUserId: string | null }) {
  const { data, loading, error } = useFomoTraderActivity(fomoUserId);

  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5">
        <h3 className="oct-eyebrow">Recent activity</h3>
        {loading && (
          <span className="w-3 h-3 border-2 border-oct-muted border-t-transparent rounded-full animate-spin" />
        )}
      </div>

      {error && (
        <div className="px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
          {error}
        </div>
      )}

      {!error && data && data.entries.length === 0 && !loading && (
        <p className="text-sm text-oct-muted">No recorded swaps or transfers.</p>
      )}

      {!error && data && data.entries.length > 0 && (
        <div className="space-y-2">
          <SummaryLine data={data} />
          <ul className="oct-card oct-card-flush divide-y divide-oct-border">
            {data.entries.map((entry, idx) =>
              entry.kind === 'swap' ? (
                <SwapRow key={entryKey(entry, idx)} swap={entry} />
              ) : (
                <TransferRow key={entryKey(entry, idx)} transfer={entry} />
              ),
            )}
          </ul>
          {data.truncated && (
            // fomo.family caps this endpoint at 100 records and exposes no
            // working cursor to page past it, so say exactly that instead of
            // implying the list is the trader's whole history.
            <p className="text-[11px] text-oct-muted leading-relaxed">
              Most recent {data.limit} records only — fomo.family caps this feed and offers no way
              to page further back.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
