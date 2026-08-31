import { useCallback, useEffect, useMemo, useState } from 'react';
import { BellRing, Plus, Trash2, RefreshCw } from 'lucide-react';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import FullPageSpinner from '../common/FullPageSpinner';
import { useAppStore } from '../../stores/appStore';
import { API_BASE, apiFetch } from '../../stores/appStore.helpers';
import type { PriceAlert, PriceAlertDirection, PriceAlertMetric } from '../../types';

const TH = 'px-3 py-2 font-medium';
/**
 * Slow background refresh. The `price_alert` WS frame is what actually moves a
 * row from armed to fired in real time; this only catches alerts that fired
 * while this tab was closed.
 */
const REFRESH_MS = 60_000;

function formatUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

function timeLabel(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Parse the target the operator typed. "150k" / "1.2M" / "150,000" all mean
 * what you'd expect — this field exists because they think in "150K mcap", and
 * making them count zeros is how a level gets set wrong.
 */
function parseTarget(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const m = /^([0-9]*\.?[0-9]+)([kmb])?$/i.exec(cleaned);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const mult = m[2]?.toLowerCase() === 'b' ? 1e9 : m[2]?.toLowerCase() === 'm' ? 1e6 : m[2]?.toLowerCase() === 'k' ? 1e3 : 1;
  return base * mult;
}

/**
 * Price Alerts — operator-SET levels on operator-CHOSEN tokens.
 *
 * Lives on the Callers page rather than in Portfolio → Journal because it is a
 * watchlist, not a position: these are tokens the operator wants to BUY at a
 * level, and Journal only knows about coins they already hold. It is a Callers
 * subnav tab rather than a new top-level page, and rather than a control inside
 * RadarTable.tsx (~960 lines and a known refactor target).
 *
 * This is its own independent signal. It shares no detection with revival or
 * breakout — there is no detection at all. The operator names the number.
 */
export default function PriceAlerts() {
  // A `price_alert` WS frame bumps this, so a firing moves the row without polling.
  const lastEventAt = useAppStore((s) => s.priceAlertLastEventAt);

  const [alerts, setAlerts] = useState<PriceAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [mint, setMint] = useState('');
  const [direction, setDirection] = useState<PriceAlertDirection>('above');
  const [metric, setMetric] = useState<PriceAlertMetric>('mcap');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch(`${API_BASE}/price-alerts`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { alerts: PriceAlert[] };
      setAlerts(body.alerts ?? []);
      setError(null);
    } catch {
      setError('Failed to load price alerts');
      setAlerts((prev) => prev ?? []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, lastEventAt]);

  const parsedTarget = useMemo(() => parseTarget(target), [target]);

  const submit = async () => {
    if (submitting) return;
    const value = parsedTarget;
    if (!mint.trim()) return setFormError('Paste a token address');
    if (value == null) return setFormError('Target must be a number (150k, 1.2M, 0.004)');
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await apiFetch(`${API_BASE}/price-alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mint: mint.trim(),
          direction,
          metric,
          targetUsd: value,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setMint('');
      setTarget('');
      setNote('');
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError((err as Error).message || 'Failed to create alert');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await apiFetch(`${API_BASE}/price-alerts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAlerts((prev) => (prev ?? []).filter((a) => a.id !== id));
    } catch {
      setError('Failed to delete alert');
    }
  };

  if (alerts == null) {
    return <FullPageSpinner />;
  }

  const armed = alerts.filter((a) => a.status === 'armed');
  const rest = alerts.filter((a) => a.status !== 'armed');

  const form = (
    <div className="shrink-0 border-b border-oct-border bg-oct-surface-raised/40 px-4 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 flex-1 min-w-[260px]">
          <span className="font-mono text-[10px] uppercase tracking-wider text-oct-muted">Token address (Solana)</span>
          <input
            className="oct-input font-mono text-xs px-2.5 py-1.5"
            placeholder="mint address"
            value={mint}
            onChange={(e) => setMint(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-oct-muted">Crosses</span>
          <select
            className="oct-input font-mono text-xs px-2.5 py-1.5"
            value={direction}
            onChange={(e) => setDirection(e.target.value as PriceAlertDirection)}
          >
            <option value="above">above</option>
            <option value="below">below</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-oct-muted">Measured in</span>
          <select
            className="oct-input font-mono text-xs px-2.5 py-1.5"
            value={metric}
            onChange={(e) => setMetric(e.target.value as PriceAlertMetric)}
          >
            <option value="mcap">market cap</option>
            <option value="price">price</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 w-[140px]">
          <span className="font-mono text-[10px] uppercase tracking-wider text-oct-muted">Target (USD)</span>
          <input
            className="oct-input font-mono text-xs px-2.5 py-1.5"
            placeholder="150k"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <span className="font-mono text-[10px] uppercase tracking-wider text-oct-muted">Note (why this level)</span>
          <input
            className="oct-input font-mono text-xs px-2.5 py-1.5"
            placeholder="entry band from the 4h retest"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="oct-btn-primary px-3 py-1.5 text-xs font-bold uppercase"
        >
          {submitting ? 'saving…' : 'arm alert'}
        </button>
      </div>
      <div className="mt-2 font-mono text-[11px] text-oct-muted">
        {formError ? (
          <span className="text-oct-flame">{formError}</span>
        ) : (
          <>
            {parsedTarget != null && <span className="text-oct-text">reads as {formatUsd(parsedTarget)} · </span>}
            fires on the CROSSING, once. The first reading after you arm it is the baseline, so a token already past
            your level won&apos;t ping instantly — it pings when it genuinely crosses.
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      <div className="oct-headerbar shrink-0 flex items-center gap-2 px-4 py-2.5">
        <span className="oct-eyebrow">view: price alerts</span>
        <div className="flex-1" />
        {error && <span className="font-mono text-[11px] text-oct-flame">{error}</span>}
        <span className="font-mono text-[11px] text-oct-muted tabular-nums">
          {armed.length} armed · {rest.length} fired
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="oct-icon-btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold uppercase"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : undefined} />
          refresh
        </button>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="oct-icon-btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold uppercase"
        >
          <Plus size={12} />
          new alert
        </button>
      </div>

      {showForm && form}

      {alerts.length === 0 ? (
        <ConsoleEmptyState
          icon={BellRing}
          eyebrow="[ CALL · ALERTS ]"
          title="No price alerts set"
          description="Pick a token and a level — 'ping me if it crosses 150K mcap' — and OCT watches it for you. Nothing is detected or scored here: you name the number, and the alert fires once, on the crossing."
          actionLabel="NEW ALERT"
          onActionClick={() => setShowForm(true)}
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto overscroll-contain" style={{ overflowAnchor: 'none' }}>
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead className="oct-thead sticky top-0 z-10">
              <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
                <th className={TH}>Status</th>
                <th className={TH}>Token</th>
                <th className={TH}>Level</th>
                <th className={`${TH} text-right`}>Last seen</th>
                <th className={`${TH} text-right`}>When</th>
                <th className={TH}>Note</th>
                <th className={`${TH} text-right`}>·</th>
              </tr>
            </thead>
            <tbody>
              {[...armed, ...rest].map((a) => {
                const sym = a.symbol ? `$${a.symbol}` : `${a.mint.slice(0, 6)}…`;
                const fired = a.status === 'fired';
                return (
                  <tr
                    key={a.id}
                    className={`border-b border-oct-border/50 oct-row-hover ${fired ? 'bg-oct-accent/5' : ''}`}
                  >
                    <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                      {fired ? (
                        <span className="text-oct-green font-bold">crossed</span>
                      ) : a.status === 'disabled' ? (
                        <span className="text-oct-muted">off</span>
                      ) : (
                        <span className="text-oct-yellow flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-oct-yellow animate-pulse-live" />
                          armed
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          window.open(
                            `https://dexscreener.com/${a.chain}/${a.mint}`,
                            '_blank',
                            'noopener,noreferrer',
                          )
                        }
                        className="font-mono text-xs font-bold text-oct-text hover:text-oct-accent hover:underline transition-colors"
                        title={a.mint}
                      >
                        {sym}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-oct-text whitespace-nowrap">
                      {a.direction} {formatUsd(a.targetUsd)}
                      <span className="ml-1.5 text-[10px] uppercase tracking-wider text-oct-muted">
                        {a.metric === 'mcap' ? 'mcap' : 'price'}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-right tabular-nums text-oct-muted">
                      {/* Fired rows show the value AT the crossing; armed rows the latest observation. */}
                      {fired ? formatUsd(a.firedValueUsd) : formatUsd(a.lastSeenUsd)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-right tabular-nums text-oct-muted whitespace-nowrap">
                      {timeLabel(fired ? a.firedAt : a.lastSeenAt)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-oct-muted max-w-[280px] truncate" title={a.note ?? ''}>
                      {a.note ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void remove(a.id)}
                        className="oct-icon-btn p-1.5"
                        title="Delete alert"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
