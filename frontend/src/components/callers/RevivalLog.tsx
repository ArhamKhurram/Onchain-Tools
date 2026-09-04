import { useCallback, useEffect, useState } from 'react';
import { Flame, RefreshCw, Copy, Check } from 'lucide-react';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import RevivalStats from './RevivalStats';
import FullPageSpinner from '../common/FullPageSpinner';
import { useAppStore } from '../../stores/appStore';
import { API_BASE, apiFetch } from '../../stores/appStore.helpers';
import {
  buildRevivalContractUrl,
  revivalNetworkLabel,
  DEFAULT_LINK_TEMPLATES,
} from '../../utils/contractUrl';
import { formatMcap } from '../../types/pumpfun';
import type { RevivalAlertEntry } from '../../types';

// Header cells share SortHeader's padding so the Radar and this log line up.
const TH = 'px-3 py-2 font-medium';
// Body cells: 12px horizontal, 6px vertical — one step tighter than before.
const TD = 'px-comfy py-snug';
/** Peaks update server-side every ~10 min; a slow background refresh keeps
 * open rows honest without hammering the API. */
const REFRESH_MS = 120_000;

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function multipleClass(multiple: number | null): string {
  if (multiple == null) return 'text-oct-muted';
  if (multiple >= 2) return 'text-oct-good font-bold';
  if (multiple < 1.2) return 'text-oct-muted';
  return 'text-oct-text';
}

/**
 * How far the token had ALREADY run when the alert fired (price at alert ÷
 * pre-ignition baseline). This is the honesty column: near 1x means the alert
 * caught the ignition, a big number means it caught the middle of a move —
 * the failure this log used to hide. The detector's run gate now refuses to
 * fire above 3x, so elevated values here should only appear on legacy rows;
 * if they start appearing on new ones, the gate needs recalibrating.
 */
function runClass(multiple: number | null): string {
  if (multiple == null) return 'text-oct-muted';
  // Semantic, not brand: >3x at alert time is a failure of the gate, so it
  // reads as critical; 1.5–3x is caution.
  if (multiple > 3) return 'text-oct-critical font-bold';
  if (multiple > 1.5) return 'text-oct-warn';
  return 'text-oct-muted';
}

/**
 * Revival log — every fired revival ignition alert, persisted with the mcap
 * it fired AT plus the peak reached in the 24h after (tracked server-side).
 * This is the review surface for "was that alert actually useful?" and for
 * catching up on an alert that fired while nobody was at the console.
 */
export default function RevivalLog() {
  const config = useAppStore((s) => s.config);
  // A new `revival_alert` WS frame lands in activeRevivals before anything
  // else — the newest banner's timestamp is the refetch trigger, so the log
  // reflects a fresh ignition without polling for it.
  const latestRevivalAt = useAppStore((s) => s.activeRevivals[0]?.triggeredAt);

  const [alerts, setAlerts] = useState<RevivalAlertEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Which mint's CA was just copied — drives the transient ✓ on its button.
  const [copiedMint, setCopiedMint] = useState<string | null>(null);

  const copyMint = useCallback((mint: string) => {
    void navigator.clipboard?.writeText(mint);
    setCopiedMint(mint);
    setTimeout(() => setCopiedMint((m) => (m === mint ? null : m)), 1200);
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch(`${API_BASE}/revival/alerts?limit=200`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { alerts: RevivalAlertEntry[] };
      setAlerts(body.alerts ?? []);
      setError(null);
    } catch {
      setError('Failed to load revival log');
      setAlerts((prev) => prev ?? []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, latestRevivalAt]);

  if (alerts == null) {
    return <FullPageSpinner />;
  }

  if (alerts.length === 0) {
    return (
      <ConsoleEmptyState
        icon={Flame}
        eyebrow="[ CALL · REVIVAL ]"
        title="No revivals yet"
        description="When a dormant token on your radar ignites, the alert is stored here with the mcap it fired at — and its peak over the following 24h, so you can judge it later even if you missed the banner."
        actionLabel="REFRESH"
        onActionClick={() => void load()}
      />
    );
  }

  const templates = config?.contractLinkTemplates ?? DEFAULT_LINK_TEMPLATES;

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      <div className="oct-headerbar shrink-0 flex items-center gap-cozy px-roomy py-cozy">
        <span className="oct-eyebrow">view: revival log</span>
        <div className="flex-1" />
        {error && <span className="type-caption text-oct-critical">{error}</span>}
        <span className="type-data text-oct-muted">{alerts.length} alerts</span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="oct-icon-btn flex items-center gap-snug px-cozy py-snug font-mono text-2xs font-bold uppercase"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : undefined} />
          refresh
        </button>
      </div>

      <RevivalStats alerts={alerts} fetchLimit={200} />

      <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
        <table className="w-full text-left border-collapse min-w-[920px]">
          <thead className="oct-thead sticky top-0 z-10">
            <tr className="font-mono type-caption font-bold uppercase tracking-wider text-oct-muted">
              <th className={TH}>When</th>
              <th className={TH}>Token</th>
              <th className={TH}>Network</th>
              <th className={`${TH} text-right`}>MC @ alert</th>
              <th className={`${TH} text-right`}>Run @ alert</th>
              <th className={`${TH} text-right`}>Peak since</th>
              <th className={`${TH} text-right`}>Multiple</th>
              <th className={`${TH} text-right`}>Signal</th>
              <th className={TH}>Status</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => {
              const sym = a.symbol ? `$${a.symbol}` : `${a.mint.slice(0, 6)}…`;
              const chain = revivalNetworkLabel(a.network);
              // Chain-aware link — the row's own network decides the explorer
              // /chart, not the address shape.
              const url = buildRevivalContractUrl(a.mint, a.network, templates);
              const tracking = a.outcomeWindowClosedAt == null;
              return (
                <tr key={a.id} className="border-b border-oct-border/50 oct-row-hover">
                  <td className={`${TD} type-data text-oct-muted whitespace-nowrap`}>
                    {timeLabel(a.triggeredAt)}
                  </td>
                  <td className={TD}>
                    <button
                      type="button"
                      onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                      className="type-data font-bold text-oct-text hover:text-oct-accent hover:underline transition-colors"
                      title={`Open ${sym} on ${chain} (${a.mint})`}
                    >
                      {sym}
                    </button>
                    {/* Copy the raw CA — the symbol opens the platform, but you
                        often just want the address to paste into a terminal. */}
                    <button
                      type="button"
                      onClick={() => copyMint(a.mint)}
                      className="ml-snug align-middle p-hair rounded-oct-sm text-oct-muted hover:text-oct-accent hover:bg-oct-surface transition-colors"
                      title={copiedMint === a.mint ? 'Copied' : `Copy CA (${a.mint})`}
                      aria-label="Copy contract address"
                    >
                      {copiedMint === a.mint ? <Check size={12} className="text-oct-good" /> : <Copy size={12} />}
                    </button>
                    {/* Signal kind — rows without one predate breakout and are revivals. */}
                    <span className={`ml-snug align-middle text-2xs leading-none font-mono font-bold uppercase tracking-wider px-snug py-hair rounded-oct-sm border ${a.kind === 'breakout' ? 'text-oct-accent-2 border-oct-accent-2/40 bg-oct-accent-2/10' : 'text-oct-accent border-oct-accent/40 bg-oct-accent/10'}`}>
                      {a.kind === 'breakout' ? 'BREAKOUT' : 'REVIVAL'}
                    </span>
                  </td>
                  <td className={TD}>
                    <span
                      className="text-2xs leading-none font-mono uppercase tracking-wider px-cozy py-hair rounded-oct-sm border border-oct-border bg-oct-surface-raised/60 text-oct-muted"
                      title={a.network}
                    >
                      {chain}
                    </span>
                  </td>
                  <td className={`${TD} type-data text-oct-text text-right`}>
                    {formatMcap(a.mcapUsd)}
                  </td>
                  <td
                    className={`${TD} type-data text-right ${runClass(a.runMultiple)}`}
                    title={
                      a.runMultiple != null
                        ? `Already ${a.runMultiple.toFixed(2)}× above its pre-ignition baseline${a.baselinePriceUsd != null ? ` ($${a.baselinePriceUsd})` : ''} when the alert fired`
                        : 'No pre-ignition baseline was established for this alert'
                    }
                  >
                    {a.runMultiple != null ? `${a.runMultiple.toFixed(2)}×` : '—'}
                  </td>
                  <td className={`${TD} type-data text-oct-text text-right`}>
                    {formatMcap(a.peakMcapUsd)}
                  </td>
                  <td className={`${TD} type-data text-right ${multipleClass(a.peakMultiple)}`}>
                    {a.peakMultiple != null ? `${a.peakMultiple.toFixed(2)}×` : '—'}
                  </td>
                  <td className={`${TD} type-data text-oct-muted text-right whitespace-nowrap`}>
                    z {a.atrZ.toFixed(1)} · {a.rvol.toFixed(1)}x vol
                  </td>
                  <td className={`${TD} type-caption`}>
                    {tracking ? (
                      <span className="text-oct-warn flex items-center gap-snug">
                        <span className="w-1.5 h-1.5 rounded-full bg-oct-warn animate-pulse-live" />
                        tracking…
                      </span>
                    ) : (
                      <span className="text-oct-muted">closed</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
