// The top-FOMO-holders board for one token. Presentational: it takes the
// BotHoldersResponse DTO the Discord /holders command renders, so both surfaces
// stay on one contract. Mounted by TokenHoldersDrawer and the Workspace
// "Token lookup" panel.

import { ExternalLink, RefreshCw, Users } from 'lucide-react';
import type { BotHoldersResponse } from '@oct/shared';

const NETWORK_LABELS: Record<number, string> = {
  1: 'ETH',
  56: 'BSC',
  143: 'HOOD',
  8453: 'BASE',
  1399811149: 'SOL',
};

function compactUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function signedUsd(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${compactUsd(Math.abs(value))}`;
}

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

interface FomoHoldersBoardProps {
  data: BotHoldersResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh?: () => void;
  /** Address to show while the first request is still in flight. */
  pendingAddress?: string | null;
}

export default function FomoHoldersBoard({
  data,
  loading,
  error,
  onRefresh,
  pendingAddress,
}: FomoHoldersBoardProps) {
  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
        {pendingAddress && (
          <span className="font-mono text-[11px] text-oct-muted">{shortAddress(pendingAddress)}</span>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
        <Users size={20} className="text-oct-muted" />
        <p className="text-sm text-oct-muted">No token selected.</p>
      </div>
    );
  }

  const { token, holders, explorerBase, networkId } = data;
  const ticker = (token.symbol ?? 'TOKEN').toUpperCase();
  const chainLabel = NETWORK_LABELS[networkId] ?? String(networkId);
  const socials = [
    token.socials.twitter ? { label: 'Twitter', href: token.socials.twitter } : null,
    token.socials.telegram ? { label: 'Telegram', href: token.socials.telegram } : null,
    token.socials.website ? { label: 'Website', href: token.socials.website } : null,
  ].filter(Boolean) as { label: string; href: string }[];

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="oct-headerbar shrink-0 px-4 py-3">
        <div className="flex items-start gap-3">
          {token.iconUrl && (
            <img
              src={token.iconUrl}
              alt={token.name ?? ticker}
              className="w-10 h-10 rounded-oct border border-oct-border shrink-0 object-cover"
              loading="lazy"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[15px] font-extrabold text-oct-text truncate">${ticker}</span>
              <span className="oct-chip uppercase shrink-0">{chainLabel}</span>
            </div>
            <a
              href={`${explorerBase}${token.address}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs text-oct-muted hover:text-oct-text transition-colors"
              title={token.address}
            >
              {shortAddress(token.address)}
              <ExternalLink size={10} />
            </a>
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="oct-icon-btn shrink-0 p-2"
              title="Refresh holders"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs font-mono text-oct-muted">
          {token.marketCap != null && <span>MCap {compactUsd(token.marketCap)}</span>}
          {token.priceUsd != null && token.priceUsd > 0 && (
            <span>${token.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
          )}
          {socials.map((s) => (
            <a
              key={s.label}
              href={s.href}
              target="_blank"
              rel="noreferrer"
              className="hover:text-oct-text transition-colors underline decoration-dotted"
            >
              {s.label}
            </a>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {holders.length === 0 ? (
          <div className="py-16 px-6 text-center text-sm text-oct-muted">
            No FOMO holders for this token.
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {holders.map((holder) => (
              <li
                key={`${holder.rank}-${holder.address || holder.name}`}
                className="flex items-center gap-3 px-4 py-3 oct-row-hover"
              >
                <span className="w-6 text-[13px] font-mono font-bold text-oct-muted tabular-nums shrink-0">
                  {holder.rank}
                </span>
                <div className="min-w-0 flex-1">
                  {holder.address ? (
                    <a
                      href={`${explorerBase}${holder.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[15px] font-bold text-oct-text truncate hover:text-oct-accent transition-colors block"
                      title={holder.address}
                    >
                      {holder.name}
                    </a>
                  ) : (
                    <span className="text-[15px] font-bold text-oct-text truncate block">{holder.name}</span>
                  )}
                </div>
                <div className="shrink-0 text-right font-mono text-[13px] tabular-nums">
                  <div className="text-oct-text">{compactUsd(holder.valueUsd)}</div>
                  <div className={holder.pnlUsd >= 0 ? 'text-oct-green' : 'text-oct-flame'}>
                    {signedUsd(holder.pnlUsd)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
