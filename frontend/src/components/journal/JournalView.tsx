import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import JournalCurve from './JournalCurve';
import FullPageSpinner from '../common/FullPageSpinner';
import { useAuthSession } from '../../hooks/useAuthSession';
import { useAppStore } from '../../stores/appStore';
import { API_BASE, apiFetch } from '../../stores/appStore.helpers';
import { isHostedMode } from '../../lib/supabase';
import { routes } from '../../lib/routes';
import type { JournalPosition, JournalSummary, JournalWallet } from '../../types';

/** Background refresh; WS `journal_update` frames trigger an immediate one. */
const REFRESH_MS = 60_000;
const TH = 'px-3 py-2 font-medium';

function fmtSol(n: number | null | undefined, signed = true): string {
  if (n == null) return '—';
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(Math.abs(n) >= 100 ? 1 : 2)} SOL`;
}

function fmtUsd(n: number | null | undefined, signed = true): string {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : signed && n > 0 ? '+' : '';
  const abs = Math.abs(n);
  const body = abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(2)}M` : abs >= 1_000 ? `${(abs / 1_000).toFixed(1)}K` : abs.toFixed(abs < 10 ? 2 : 0);
  return `${sign}$${body}`;
}

function pnlClass(n: number | null | undefined): string {
  if (n == null) return 'text-oct-muted';
  if (n > 0) return 'text-oct-green';
  if (n < 0) return 'text-oct-flame';
  return 'text-oct-text';
}

function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Trade Journal v1 — the operator's own wallets, ingested automatically:
 * cumulative realized PnL curve, day list, open positions, and the header's
 * GIVE-BACK METER (distance below the curve's all-time high). The audit found
 * run-up→give-back cycles going unnoticed until the money was gone; this tab
 * exists so the current giveback is a number, not a feeling.
 */
export default function JournalView() {
  const { isAuthenticated, ready } = useAuthSession();
  const journalLastEventAt = useAppStore((s) => s.journalLastEventAt);

  const [wallets, setWallets] = useState<JournalWallet[] | null>(null);
  const [heliusConfigured, setHeliusConfigured] = useState(true);
  const [summary, setSummary] = useState<JournalSummary | null>(null);
  const [positions, setPositions] = useState<JournalPosition[]>([]);
  // Same panel, same table — just which side of the ledger it lists. Closed is
  // where auto-closed dead bags land (see backend/src/journal/abandoned.ts).
  const [positionTab, setPositionTab] = useState<'open' | 'closed'>('open');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addAddress, setAddAddress] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [walletsRes, summaryRes, positionsRes] = await Promise.all([
        apiFetch(`${API_BASE}/journal/wallets`),
        apiFetch(`${API_BASE}/journal/summary`),
        apiFetch(`${API_BASE}/journal/positions?status=${positionTab}`),
      ]);
      if (!walletsRes.ok || !summaryRes.ok || !positionsRes.ok) {
        throw new Error('journal fetch failed');
      }
      const walletsBody = (await walletsRes.json()) as { wallets: JournalWallet[]; heliusConfigured?: boolean };
      const summaryBody = (await summaryRes.json()) as { summary: JournalSummary };
      const positionsBody = (await positionsRes.json()) as { positions: JournalPosition[] };
      setWallets(walletsBody.wallets ?? []);
      setHeliusConfigured(walletsBody.heliusConfigured !== false);
      setSummary(summaryBody.summary);
      setPositions(positionsBody.positions ?? []);
      setError(null);
    } catch {
      setError('Failed to load journal');
      setWallets((prev) => prev ?? []);
    } finally {
      setRefreshing(false);
    }
  }, [positionTab]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
    // journalLastEventAt: a WS journal frame means fresh server data → refetch.
  }, [load, journalLastEventAt]);

  const addWallet = async () => {
    const address = addAddress.trim();
    if (!address) return;
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await apiFetch(`${API_BASE}/journal/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, label: addLabel.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setAddAddress('');
      setAddLabel('');
      setAddOpen(false);
      await load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add wallet');
    } finally {
      setAddBusy(false);
    }
  };

  const removeWallet = async (wallet: JournalWallet) => {
    try {
      const res = await apiFetch(`${API_BASE}/journal/wallets/${wallet.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch {
      setError('Failed to remove wallet');
    }
  };

  const listedPositions = useMemo(
    () => [...positions].sort((a, b) => new Date(b.lastTradeAt).getTime() - new Date(a.lastTradeAt).getTime()),
    [positions],
  );

  if (!ready || wallets === null) {
    return <FullPageSpinner />;
  }

  if (isHostedMode && !isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={BookOpen}
        eyebrow="[ PORTFOLIO · JOURNAL ]"
        title="Sign in for your journal"
        description="The trade journal ingests your own wallets' swaps and shows realized PnL, win rate, and how far you sit below your high-water mark."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  const giveback = summary?.drawdownFromPeakSol ?? 0;
  const givebackActive = giveback > 0.000001;

  return (
    <div className="h-full flex flex-col min-h-0 bg-oct-bg overflow-hidden">
      <div className="oct-headerbar shrink-0 flex items-center gap-2 px-4 py-2.5">
        <span className="oct-eyebrow">view: trade journal</span>
        <div className="flex-1" />
        {error && <span className="font-mono text-[11px] text-oct-flame">{error}</span>}
        <span className="font-mono text-[11px] text-oct-muted tabular-nums">
          {wallets.length} wallet{wallets.length === 1 ? '' : 's'} · {summary?.totalTrades ?? 0} trades
        </span>
        <button
          type="button"
          onClick={() => setAddOpen((v) => !v)}
          className="oct-icon-btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold uppercase"
        >
          <Plus size={12} />
          wallet
        </button>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="oct-icon-btn flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold uppercase"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : undefined} />
          refresh
        </button>
      </div>

      {addOpen && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-oct-border bg-oct-panel">
          <input
            value={addAddress}
            onChange={(e) => setAddAddress(e.target.value)}
            placeholder="Solana wallet address (your own)"
            spellCheck={false}
            className="oct-input flex-1 min-w-[260px] font-mono text-xs px-2.5 py-1.5 bg-oct-bg border border-oct-border rounded-oct-sm text-oct-text placeholder:text-oct-muted/60"
          />
          <input
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
            placeholder="Label (optional)"
            className="oct-input w-40 font-mono text-xs px-2.5 py-1.5 bg-oct-bg border border-oct-border rounded-oct-sm text-oct-text placeholder:text-oct-muted/60"
          />
          <button
            type="button"
            onClick={() => void addWallet()}
            disabled={addBusy || !addAddress.trim()}
            className="oct-icon-btn px-3 py-1.5 text-xs font-bold uppercase disabled:opacity-50"
          >
            {addBusy ? 'adding…' : 'add'}
          </button>
          {addError && <span className="font-mono text-[11px] text-oct-flame">{addError}</span>}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 sm:px-6 py-4 space-y-4">
        {!heliusConfigured && (
          <div className="rounded-oct border border-oct-yellow/50 bg-oct-yellow/10 px-4 py-3 font-mono text-xs text-oct-yellow">
            Journal ingestion requires <code className="text-oct-text">HELIUS_API_KEY</code> on the backend —
            wallets can be added but no trades will arrive until it is set.
          </div>
        )}

        {wallets.length === 0 ? (
          <div className="rounded-oct border border-oct-border bg-oct-panel px-4 py-6 text-center">
            <p className="font-mono text-sm text-oct-text mb-1.5">No journal wallets yet</p>
            <p className="font-mono text-xs text-oct-muted max-w-lg mx-auto">
              Add your OWN trading wallets (not tracked/copy wallets — those live in Directory). OCT ingests
              every swap automatically, pairs buys to sells FIFO, and keeps the give-back meter honest.
            </p>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="oct-icon-btn mt-3 px-4 py-2 text-xs font-bold uppercase"
            >
              <Plus size={12} /> Add wallet
            </button>
          </div>
        ) : (
          <>
            {/* Header stat row — the give-back meter is the point of the page. */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-oct border border-oct-border bg-oct-panel px-4 py-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-oct-muted mb-1">7d realized PnL</p>
                <p className={`font-mono text-lg font-bold tabular-nums ${pnlClass(summary?.realized7dSol)}`}>
                  {fmtSol(summary?.realized7dSol)}
                </p>
                <p className="font-mono text-[11px] text-oct-muted tabular-nums">{fmtUsd(summary?.realized7dUsd)}</p>
              </div>
              <div className="rounded-oct border border-oct-border bg-oct-panel px-4 py-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-oct-muted mb-1">Win rate</p>
                <p className="font-mono text-lg font-bold tabular-nums text-oct-text">
                  {summary?.winRate != null ? `${(summary.winRate * 100).toFixed(0)}%` : '—'}
                </p>
                <p className="font-mono text-[11px] text-oct-muted tabular-nums">
                  {summary?.closedEpisodes ?? 0} closed · {summary?.openEpisodes ?? 0} open
                </p>
              </div>
              <div className="rounded-oct border border-oct-border bg-oct-panel px-4 py-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-oct-muted mb-1">Cumulative realized</p>
                <p className={`font-mono text-lg font-bold tabular-nums ${pnlClass(summary?.cumRealizedSol)}`}>
                  {fmtSol(summary?.cumRealizedSol)}
                </p>
                <p className="font-mono text-[11px] text-oct-muted tabular-nums">{fmtUsd(summary?.cumRealizedUsd)}</p>
              </div>
              <div
                className={`rounded-oct border px-4 py-3 ${
                  givebackActive ? 'border-oct-flame/60 bg-oct-flame/10' : 'border-oct-border bg-oct-panel'
                }`}
                title="Distance of cumulative realized PnL below its all-time high — the run-up you have given back."
              >
                <p className={`font-mono text-[10px] uppercase tracking-wider mb-1 ${givebackActive ? 'text-oct-flame' : 'text-oct-muted'}`}>
                  Give-back from peak
                </p>
                <p className={`font-mono text-lg font-bold tabular-nums ${givebackActive ? 'text-oct-flame' : 'text-oct-green'}`}>
                  {givebackActive ? `-${giveback.toFixed(2)} SOL` : 'AT HIGHS'}
                </p>
                <p className={`font-mono text-[11px] tabular-nums ${givebackActive ? 'text-oct-flame/80' : 'text-oct-muted'}`}>
                  {givebackActive
                    ? summary?.drawdownFromPeakUsd != null
                      ? `-${fmtUsd(summary.drawdownFromPeakUsd, false).replace('$', '$')} below peak`
                      : 'below peak'
                    : `peak ${fmtSol(summary?.peakCumRealizedSol, false)}`}
                </p>
              </div>
            </div>

            {/* Cumulative realized PnL curve */}
            <div className="rounded-oct border border-oct-border bg-oct-panel px-4 py-3">
              <p className="font-mono text-[10px] uppercase tracking-wider text-oct-muted mb-2">
                Cumulative realized PnL (SOL)
              </p>
              <JournalCurve curve={summary?.curve ?? []} givebackActive={givebackActive} />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 min-h-0">
              {/* Day list */}
              <div className="rounded-oct border border-oct-border bg-oct-panel overflow-hidden">
                <p className="font-mono text-[10px] uppercase tracking-wider text-oct-muted px-3 pt-3 pb-1">Days</p>
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="oct-thead sticky top-0 z-10">
                      <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
                        <th className={TH}>Date</th>
                        <th className={`${TH} text-right`}>Sells</th>
                        <th className={`${TH} text-right`}>Realized</th>
                        <th className={`${TH} text-right`}>USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(summary?.days ?? []).map((d) => (
                        <tr key={d.date} className="border-b border-oct-border/50 oct-row-hover">
                          <td className="px-3 py-1.5 font-mono text-xs text-oct-muted whitespace-nowrap">{dayLabel(d.date)}</td>
                          <td className="px-3 py-1.5 font-mono text-xs text-oct-muted text-right tabular-nums">{d.trades}</td>
                          <td className={`px-3 py-1.5 font-mono text-xs text-right tabular-nums ${pnlClass(d.realizedPnlSol)}`}>
                            {fmtSol(d.realizedPnlSol)}
                          </td>
                          <td className={`px-3 py-1.5 font-mono text-xs text-right tabular-nums ${pnlClass(d.realizedPnlUsd)}`}>
                            {fmtUsd(d.realizedPnlUsd)}
                          </td>
                        </tr>
                      ))}
                      {(summary?.days ?? []).length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-3 py-4 font-mono text-xs text-oct-muted text-center">
                            No realized trades yet — sells appear here once ingestion catches up.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Positions — open by default, closed for history */}
              <div className="rounded-oct border border-oct-border bg-oct-panel overflow-hidden">
                <div className="flex items-center gap-2 px-3 pt-3 pb-1">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-oct-muted">Positions</p>
                  <div className="flex-1" />
                  {(['open', 'closed'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setPositionTab(tab)}
                      className={`font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-oct-sm transition-colors ${
                        positionTab === tab
                          ? 'text-oct-text bg-oct-border/60'
                          : 'text-oct-muted hover:text-oct-text'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-left border-collapse min-w-[420px]">
                    <thead className="oct-thead sticky top-0 z-10">
                      <tr className="font-mono text-[10px] font-bold uppercase tracking-wider text-oct-muted">
                        <th className={TH}>Token</th>
                        <th className={`${TH} text-right`}>Size</th>
                        <th className={`${TH} text-right`}>Entry (SOL)</th>
                        <th className={`${TH} text-right`}>Value now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listedPositions.map((p) => {
                        const valueNow = p.lastPriceUsd != null ? p.remainingToken * p.lastPriceUsd : null;
                        const sym = p.symbol ? `$${p.symbol}` : `${p.mint.slice(0, 6)}…`;
                        return (
                          <tr key={p.id} className="border-b border-oct-border/50 oct-row-hover">
                            <td className="px-3 py-1.5">
                              <button
                                type="button"
                                onClick={() => window.open(`https://dexscreener.com/solana/${p.mint}`, '_blank', 'noopener,noreferrer')}
                                className="font-mono text-xs font-bold text-oct-text hover:text-oct-accent hover:underline transition-colors"
                                title={`${p.mint} (${p.walletAddress.slice(0, 6)}…)`}
                              >
                                {sym}
                              </button>
                              {p.pnlIncomplete && (
                                <span
                                  className="ml-1.5 text-[9px] font-mono text-oct-yellow"
                                  title="Some legs had no SOL/USD value (stable-paid or token-to-token) — PnL under-reports them."
                                >
                                  ~
                                </span>
                              )}
                              {p.closeReason === 'abandoned' && (
                                <span
                                  className="ml-1.5 px-1 py-px rounded-oct-sm border border-oct-flame/50 text-[9px] font-mono uppercase text-oct-flame"
                                  title="Auto-closed as a dead bag (no LP, or worth ~$0, untouched for days). Booked as a sale at zero proceeds — the unrecovered cost is a real realized loss. Tokens are still held."
                                >
                                  abandoned
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-xs text-oct-muted text-right tabular-nums">
                              {p.remainingToken >= 1_000_000
                                ? `${(p.remainingToken / 1_000_000).toFixed(1)}M`
                                : p.remainingToken >= 1_000
                                  ? `${(p.remainingToken / 1_000).toFixed(1)}K`
                                  : p.remainingToken.toFixed(0)}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-xs text-oct-text text-right tabular-nums">
                              {p.costSol > 0 ? p.costSol.toFixed(2) : '—'}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-xs text-oct-text text-right tabular-nums">
                              {fmtUsd(valueNow, false)}
                            </td>
                          </tr>
                        );
                      })}
                      {listedPositions.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-3 py-4 font-mono text-xs text-oct-muted text-center">
                            {positionTab === 'open' ? 'Flat — no open positions.' : 'No closed episodes yet.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Wallets */}
            <div className="rounded-oct border border-oct-border bg-oct-panel overflow-hidden">
              <p className="font-mono text-[10px] uppercase tracking-wider text-oct-muted px-3 pt-3 pb-1">
                Journal wallets
              </p>
              <ul>
                {wallets.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center gap-3 px-3 py-2 border-b border-oct-border/50 last:border-b-0"
                  >
                    <span className="font-mono text-xs text-oct-text truncate">{w.address}</span>
                    {w.label && <span className="font-mono text-[11px] text-oct-muted shrink-0">{w.label}</span>}
                    <span className="flex-1" />
                    <span className="font-mono text-[10px] text-oct-muted shrink-0" title="Last ingestion cycle">
                      {w.lastPolledAt
                        ? `polled ${new Date(w.lastPolledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                        : 'awaiting first poll'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeWallet(w)}
                      title="Remove wallet (deletes its journal data)"
                      className="oct-icon-btn px-2 py-1.5 hover:!text-oct-flame shrink-0"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
