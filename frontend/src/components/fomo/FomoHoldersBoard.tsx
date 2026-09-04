// The top-FOMO-holders board for one token. Presentational: it takes the
// BotHoldersResponse DTO the Discord /holders command renders, so both surfaces
// stay on one contract. Mounted by TokenHoldersDrawer and the Workspace
// "Token lookup" panel.

import { ExternalLink, RefreshCw, Users } from 'lucide-react';
import type { BotHoldersResponse } from '@oct/shared';
import Chip from '../common/Chip';
import { cn } from '../../lib/utils';

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
      <div className="flex flex-col items-center justify-center gap-comfy py-gutter">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
        {pendingAddress && <span className="type-data text-oct-muted">{shortAddress(pendingAddress)}</span>}
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="m-comfy px-comfy py-cozy rounded-oct border border-oct-critical/50 bg-oct-critical-dim type-body text-oct-critical"
      >
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center gap-cozy py-gutter px-section text-center">
        <Users size={20} className="text-oct-muted" />
        <p className="type-body text-oct-muted">No token selected.</p>
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
      <div className="oct-headerbar shrink-0 px-roomy py-cozy">
        <div className="flex items-start gap-comfy">
          {token.iconUrl && (
            <img
              src={token.iconUrl}
              alt={token.name ?? ticker}
              className="w-9 h-9 rounded-oct border border-oct-border shrink-0 object-cover"
              loading="lazy"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-cozy min-w-0">
              <span className="type-title text-oct-text truncate">${ticker}</span>
              <Chip data={false} className="shrink-0">
                {chainLabel}
              </Chip>
            </div>
            <a
              href={`${explorerBase}${token.address}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-tight type-data text-oct-muted hover:text-oct-text transition-colors duration-fast"
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
              className="oct-icon-btn shrink-0 p-snug"
              title="Refresh holders"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-comfy gap-y-tight mt-cozy type-data text-oct-muted">
          {token.marketCap != null && (
            <span>
              <span className="type-caption font-mono uppercase tracking-wide">MCap </span>
              {compactUsd(token.marketCap)}
            </span>
          )}
          {token.priceUsd != null && token.priceUsd > 0 && (
            <span>${token.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
          )}
          {socials.map((s) => (
            <a
              key={s.label}
              href={s.href}
              target="_blank"
              rel="noreferrer"
              className="type-caption hover:text-oct-text transition-colors duration-fast underline decoration-dotted"
            >
              {s.label}
            </a>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {holders.length === 0 ? (
          <div className="py-gutter px-section text-center type-body text-oct-muted">
            No FOMO holders for this token.
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {holders.map((holder) => (
              <li
                key={`${holder.rank}-${holder.address || holder.name}`}
                className="flex items-center gap-comfy px-roomy py-snug oct-row-hover"
              >
                <span className="w-6 type-data text-oct-muted text-right shrink-0">{holder.rank}</span>
                <div className="min-w-0 flex-1">
                  {holder.address ? (
                    <a
                      href={`${explorerBase}${holder.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="type-body font-bold text-oct-text truncate hover:text-oct-accent transition-colors duration-fast block"
                      title={holder.address}
                    >
                      {holder.name}
                    </a>
                  ) : (
                    <span className="type-body font-bold text-oct-text truncate block">{holder.name}</span>
                  )}
                </div>
                {/* Holdings value above signed PnL — both `type-data` so the column aligns on the digits. */}
                <div className="shrink-0 text-right type-data">
                  <div className="text-oct-text">{compactUsd(holder.valueUsd)}</div>
                  <div className={cn(holder.pnlUsd >= 0 ? 'text-oct-good' : 'text-oct-critical')}>
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
