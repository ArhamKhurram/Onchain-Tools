// The written-theses board for one token. Presentational: it takes the
// BotThesesResponse DTO the backend narrows out of fomo.family's thesis feed, so
// every row is already { handle, xUrl, avatar, valueUsd, pnlUsd, thesis }. Mounts
// under the FOMO → Theses tab. Loading / empty / error states mirror
// FomoHoldersBoard so the two lookup surfaces feel identical.

import { FileText, RefreshCw, Users } from 'lucide-react';
import type { BotThesesResponse } from '@oct/shared';
import { compactUsd, networkLabel, shortAddress, signedUsd } from './thesisFormat';

interface FomoThesesBoardProps {
  data: BotThesesResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh?: () => void;
  /** The token address being looked up — shown in the header + spinner. */
  address: string;
}

export default function FomoThesesBoard({ data, loading, error, onRefresh, address }: FomoThesesBoardProps) {
  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
        <span className="font-mono text-[11px] text-oct-muted">{shortAddress(address)}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 px-4 py-3 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-sm text-oct-accent">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
        <FileText size={20} className="text-oct-muted" />
        <p className="text-sm text-oct-muted">No token selected.</p>
      </div>
    );
  }

  const { theses, networkId } = data;
  const chainLabel = networkLabel(networkId);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-4 py-3 border-b-2 border-black bg-oct-surface">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-extrabold text-oct-text truncate">Theses</span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-cockpit uppercase font-mono bg-oct-surface-raised text-oct-muted shrink-0">
                {chainLabel}
              </span>
            </div>
            <span className="font-mono text-[11px] text-oct-muted" title={address}>
              {shortAddress(address)}
            </span>
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="shrink-0 p-1.5 rounded-cockpit border-2 border-oct-border-bright text-oct-muted hover:text-oct-text transition-colors disabled:opacity-50"
              title="Refresh theses"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          )}
        </div>
        <div className="mt-2 text-[11px] font-mono text-oct-muted">via fomo.family</div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {theses.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
            <Users size={20} className="text-oct-muted" />
            <p className="text-sm text-oct-muted">No FOMO theses for this token yet.</p>
          </div>
        ) : (
          <ul className="divide-y divide-oct-border">
            {theses.map((entry, idx) => (
              <li key={`${entry.xHandle ?? entry.handle}-${idx}`} className="px-4 py-3 hover:bg-oct-surface-raised/60 transition-colors">
                <div className="flex items-start gap-3">
                  {entry.avatar ? (
                    <img
                      src={entry.avatar}
                      alt={entry.handle}
                      className="w-8 h-8 rounded-cockpit border-2 border-black shrink-0 object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-cockpit border-2 border-black shrink-0 bg-oct-surface-raised flex items-center justify-center text-[11px] font-bold text-oct-muted uppercase">
                      {entry.handle.slice(0, 2)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {entry.xUrl ? (
                        <a
                          href={entry.xUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-bold text-oct-text truncate hover:text-oct-accent transition-colors"
                          title={entry.xHandle ? `@${entry.xHandle}` : entry.handle}
                        >
                          {entry.handle}
                        </a>
                      ) : (
                        <span className="font-bold text-oct-text truncate">{entry.handle}</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 font-mono text-[11px] tabular-nums">
                      <span className="text-oct-muted">{compactUsd(entry.valueUsd)}</span>
                      <span className={entry.pnlUsd >= 0 ? 'text-green-400' : 'text-oct-accent'}>
                        {signedUsd(entry.pnlUsd)}
                      </span>
                    </div>
                  </div>
                </div>
                {entry.thesis ? (
                  <p className="mt-2 text-sm text-oct-text whitespace-pre-wrap break-words">{entry.thesis}</p>
                ) : (
                  <p className="mt-2 text-sm italic text-oct-muted">No thesis written.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
