// The "Top Callers" tab — OCT's own auto-discovered, keyless board. It ranks
// every caller the backend has seen in the GLOBAL pump.fun callout feed (no
// pump login, no follow needed) by call volume or peak-price reach, and lets
// you one-click Follow any of them straight into your callout alerts (reusing
// the same follow path the Following tab uses).
//
// NOT a quality/track-record ranking: a 2026-08-16 census (3,424 callouts,
// full population) found board rank on the "×" metrics correlates -0.217 with
// actual outcome — ranking higher predicts slightly *worse* results, because
// `multiple` is a running peak that can't fall below 1.0×. See
// oct-pump-kol-callout-alerts memory for the full analysis.
//
// Type scale matches the newer pump panels (sm/base, dense header) rather than the
// older text-[10px] tables.

import { ExternalLink, RefreshCw, Trophy, Plus, Check, Megaphone } from 'lucide-react';
import { usePumpTopCallers, TOP_CALLERS_WINDOWS, TOP_CALLERS_METRICS } from '../../hooks/usePumpTopCallers';
import { usePumpCallers } from '../../hooks/usePumpCallers';

const SOLSCAN_ACCOUNT = 'https://solscan.io/account/';

function shortAddress(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function formatMultiple(m: number | null): string {
  if (m == null) return '—';
  return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}×`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function PumpTopCallersTab() {
  const { callers, loading, needsAuth, error, window, setWindow, metric, setMetric, refresh } = usePumpTopCallers();
  const { followedAddresses, followByAddress, busy } = usePumpCallers();

  if (needsAuth) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-full px-6 text-center">
        <Megaphone size={28} className="text-oct-muted" />
        <p className="text-base text-oct-text font-bold">Sign in to see the Top Callers board</p>
        <p className="text-sm text-oct-muted max-w-sm">
          The board is built from the live pump.fun callout feed and is tied to a hosted account. Connect one to see
          who is calling — and follow them in one click.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg">
      {/* Controls: window + metric toggles */}
      <div className="oct-headerbar shrink-0 flex flex-wrap items-center gap-3 px-5 py-3">
        <div className="flex items-center gap-2">
          <Trophy size={16} className="text-oct-accent-2" />
          <span className="oct-section-title uppercase tracking-wide">Top Callers</span>
        </div>
        <div className="flex-1" />

        <div className="inline-flex rounded-oct-sm border border-oct-border overflow-hidden bg-oct-bg/40">
          {TOP_CALLERS_WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setWindow(w.id)}
              className={`px-3 py-1.5 text-[13px] font-bold transition-all ${
                window === w.id ? 'bg-oct-accent text-white shadow-oct-glow-accent' : 'text-oct-muted hover:text-oct-text'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        <div className="inline-flex rounded-oct-sm border border-oct-border overflow-hidden bg-oct-bg/40">
          {TOP_CALLERS_METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMetric(m.id)}
              className={`px-3 py-1.5 text-[13px] font-bold transition-all ${
                metric === m.id ? 'bg-oct-accent text-white shadow-oct-glow-accent' : 'text-oct-muted hover:text-oct-text'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void refresh()}
          className="oct-icon-btn shrink-0 px-3 py-1.5 text-sm font-bold"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <p className="shrink-0 px-5 py-1.5 text-[11px] text-oct-muted border-b border-oct-border">
        Peak × is the highest price a call's token touched afterward, not a return — most calls never get back there.
        This ranks callout volume and reach, not track record.
      </p>

      {/* Board */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading && callers.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="m-5 px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10 text-sm text-oct-text">
            {error}
          </div>
        ) : callers.length === 0 ? (
          <p className="text-sm text-oct-muted py-16 text-center px-6">
            No callers ranked yet for this window. The board fills as the feed is polled — check back shortly.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="oct-thead sticky top-0 backdrop-blur z-10">
              <tr className="text-left text-[11px] uppercase tracking-wide text-oct-muted">
                <th className="w-10 px-4 py-2.5 font-bold text-right">#</th>
                <th className="px-3 py-2.5 font-bold">Caller</th>
                <th className="px-3 py-2.5 font-bold text-right tabular-nums">Calls</th>
                <th className="px-3 py-2.5 font-bold text-right tabular-nums" title="Highest price the token reached after the call, divided by the call price. A peak the token touched, not a return you could have captured.">
                  Avg Peak ×
                </th>
                <th className="px-3 py-2.5 font-bold text-right tabular-nums" title="Highest price the token reached after the call, divided by the call price. A peak the token touched, not a return you could have captured.">
                  Best Peak ×
                </th>
                <th className="px-3 py-2.5 font-bold text-right">Last</th>
                <th className="px-4 py-2.5 font-bold text-right">Follow</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-oct-border">
              {callers.map((c, i) => {
                const followed = followedAddresses.has(c.callerAddress);
                return (
                  <tr key={c.callerAddress} className="oct-row-hover">
                    <td className="px-4 py-3 text-right font-mono font-bold text-oct-muted tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        {c.avatar ? (
                          <img
                            src={c.avatar}
                            alt=""
                            loading="lazy"
                            className="h-8 w-8 rounded-full object-cover shrink-0 bg-oct-surface-raised"
                            onError={(ev) => ((ev.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
                          />
                        ) : (
                          <span className="h-8 w-8 rounded-full bg-oct-surface-raised shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="font-bold text-oct-text truncate">
                            {c.username ? `@${c.username}` : shortAddress(c.callerAddress)}
                          </div>
                          <a
                            href={`${SOLSCAN_ACCOUNT}${c.callerAddress}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs text-oct-muted hover:text-oct-text transition-colors"
                            title={c.callerAddress}
                          >
                            {shortAddress(c.callerAddress)}
                            <ExternalLink size={11} />
                          </a>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold text-oct-text tabular-nums">
                      {c.calloutCount}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-oct-text tabular-nums">
                      {formatMultiple(c.avgMultiple)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-oct-green tabular-nums">
                      {formatMultiple(c.maxMultiple)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs text-oct-muted whitespace-nowrap">
                      {formatRelative(c.lastCalloutAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        disabled={busy || followed}
                        onClick={() =>
                          followByAddress({
                            address: c.callerAddress,
                            username: c.username,
                            avatar: c.avatar,
                            source: 'leaderboard',
                          })
                        }
                        className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-oct-sm border text-xs font-bold transition-colors ${
                          followed
                            ? 'border-oct-green/50 text-oct-green bg-oct-green/10 cursor-default'
                            : 'border-oct-border-bright text-oct-text hover:border-oct-accent hover:text-oct-accent hover:bg-oct-accent-dim'
                        }`}
                      >
                        {followed ? <Check size={12} /> : <Plus size={12} />}
                        {followed ? 'Following' : 'Follow'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
