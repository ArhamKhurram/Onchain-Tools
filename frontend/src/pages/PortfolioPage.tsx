import { useEffect, useMemo, useState } from 'react';
import { BarChart3, CalendarDays, PieChart, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import PortfolioActivityFeed from '../components/portfolio/PortfolioActivityFeed';
import PortfolioHoldingsTable from '../components/portfolio/PortfolioHoldingsTable';
import PortfolioSummary from '../components/portfolio/PortfolioSummary';
import PortfolioWalletPicker from '../components/portfolio/PortfolioWalletPicker';
import PnlCalendarModal from '../components/portfolio/PnlCalendarModal';
import PnlChartModal from '../components/portfolio/PnlChartModal';
import { useAuthSession } from '../hooks/useAuthSession';
import { useHoldingWallets } from '../hooks/useHoldingWallets';
import {
  getStoredPortfolioWalletId,
  setStoredPortfolioWalletId,
  usePortfolio,
  usePortfolioPnlDaily,
} from '../hooks/usePortfolio';
import { routes } from '../lib/routes';
import type { PortfolioPeriod } from '../types/portfolio';
import { isEvmWalletChain } from '../types/portfolio';

export default function PortfolioPage() {
  const { isAuthenticated, ready, userId } = useAuthSession();
  const { wallets, loading: walletsLoading } = useHoldingWallets(userId);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(() => getStoredPortfolioWalletId());
  const [period, setPeriod] = useState<PortfolioPeriod>('30d');
  const [chartOpen, setChartOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

  // An EVM 0x address is one wallet across all EVM chains, so collapse duplicate
  // saves (same address under eth/base/bsc) into a single picker entry.
  const pickerWallets = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof wallets = [];
    for (const w of wallets) {
      const key = isEvmWalletChain(w.chain)
        ? `evm:${w.address.toLowerCase()}`
        : `${w.chain}:${w.chain === 'solana' ? w.address : w.address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
    return out;
  }, [wallets]);

  useEffect(() => {
    if (pickerWallets.length === 0) return;
    const exists = pickerWallets.some((w) => w.id === selectedWalletId);
    if (!exists) {
      const next = pickerWallets[0].id;
      setSelectedWalletId(next);
      setStoredPortfolioWalletId(next);
    }
  }, [pickerWallets, selectedWalletId]);

  const selectedWallet = useMemo(
    () => pickerWallets.find((w) => w.id === selectedWalletId) ?? pickerWallets[0] ?? null,
    [pickerWallets, selectedWalletId],
  );

  const {
    stats,
    holdings,
    activity,
    loading,
    statsError,
    holdingsError,
    holdingsNeedsKey,
    activityError,
    gmgnMissing,
    totalHoldingsUsd,
    refresh,
  } = usePortfolio(selectedWallet, period);

  const pnlEnabled = chartOpen || calendarOpen;
  const {
    data: pnlData,
    loading: pnlLoading,
    error: pnlError,
  } = usePortfolioPnlDaily(selectedWallet, period, pnlEnabled);

  const handleWalletChange = (id: string) => {
    setSelectedWalletId(id);
    setStoredPortfolioWalletId(id);
  };

  const isEvmAggregated = selectedWallet ? isEvmWalletChain(selectedWallet.chain) : false;

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-full bg-oct-bg">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={PieChart}
        eyebrow="[ PORTFOLIO ]"
        title="Sign in to view portfolio"
        description="Portfolio reads wallets from My Wallets and pulls GMGN stats, holdings, and trade history for your buy wallets."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  if (!userId) {
    return (
      <div className="flex items-center justify-center h-full p-6 bg-oct-bg">
        <p className="font-mono text-sm text-oct-muted">Unable to load account. Try signing in again.</p>
      </div>
    );
  }

  if (!walletsLoading && wallets.length === 0) {
    return (
      <ConsoleEmptyState
        icon={PieChart}
        eyebrow="[ PORTFOLIO ]"
        title="Add a wallet in My Wallets"
        description="Portfolio uses the buy wallets you save under Wallets → My Wallets. Add at least one SOL, Base, BSC, ETH, or Robinhood (HOOD) address to get started."
        actionLabel="GO TO MY WALLETS"
        actionTo={`${routes.wallets}?view=mine`}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg overflow-hidden">
      <div className="shrink-0 px-4 sm:px-6 py-4 border-b-2 border-black bg-black/40">
        <div className="flex flex-wrap items-end gap-4 justify-between">
          <div>
            <p className="font-mono text-[10px] tracking-[0.2em] text-oct-muted mb-1">[ PORTFOLIO ]</p>
            <h1 className="font-display text-2xl sm:text-3xl text-oct-text tracking-tight">GMGN Wallet Dashboard</h1>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {pickerWallets.length > 0 && selectedWallet && (
              <PortfolioWalletPicker
                wallets={pickerWallets}
                selectedId={selectedWallet.id}
                onChange={handleWalletChange}
              />
            )}

            <div className="flex border-2 border-black">
              {(['7d', '30d'] as PortfolioPeriod[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={[
                    'font-mono text-[11px] uppercase px-3 py-2 transition-colors',
                    period === p ? 'bg-oct-accent text-black' : 'bg-oct-surface text-oct-muted hover:text-white',
                  ].join(' ')}
                >
                  {p}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => refresh()}
              className="font-mono text-[11px] uppercase border-2 border-black px-3 py-2 text-oct-muted hover:text-white inline-flex items-center gap-1"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {selectedWallet && (
          <p className="font-mono text-[10px] text-oct-muted mt-3">
            {selectedWallet.label ? `${selectedWallet.label} · ` : ''}
            {selectedWallet.address}
            {isEvmAggregated && (
              <span className="text-oct-accent"> · aggregated across ETH · Base · BSC</span>
            )}
            {' · '}
            <Link to={`${routes.wallets}?view=mine`} className="text-oct-accent hover:underline">
              Manage in My Wallets
            </Link>
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-5 space-y-5">
        {gmgnMissing && (
          <div className="border-2 border-amber-500/60 bg-amber-950/20 px-4 py-3 font-mono text-[11px] text-amber-200">
            Portfolio requires <code className="text-amber-100">GMGN_API_KEY</code> on the backend server (Railway).
          </div>
        )}

        {(statsError || activityError) && !gmgnMissing && (
          <div className="border-2 border-red-500/50 bg-red-950/20 px-4 py-3 font-mono text-[11px] text-red-200 flex items-center justify-between gap-3">
            <span>{statsError ?? activityError}</span>
            <button type="button" onClick={() => refresh()} className="underline hover:no-underline">
              Retry
            </button>
          </div>
        )}

        <PortfolioSummary stats={stats} totalHoldingsUsd={totalHoldingsUsd} loading={loading} />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setChartOpen(true)}
            className="font-mono text-[11px] uppercase border-2 border-black px-4 py-2 bg-oct-surface hover:bg-oct-accent hover:text-black inline-flex items-center gap-2"
          >
            <BarChart3 size={14} />
            PnL Chart
          </button>
          <button
            type="button"
            onClick={() => setCalendarOpen(true)}
            className="font-mono text-[11px] uppercase border-2 border-black px-4 py-2 bg-oct-surface hover:bg-oct-accent hover:text-black inline-flex items-center gap-2"
          >
            <CalendarDays size={14} />
            PnL Calendar
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 min-h-0">
          <PortfolioHoldingsTable
            holdings={holdings}
            chain={selectedWallet?.chain ?? 'solana'}
            loading={loading}
            error={holdingsError}
            needsPrivateKey={holdingsNeedsKey}
            showChainTag={isEvmAggregated}
          />
          <PortfolioActivityFeed
            activity={activity}
            chain={selectedWallet?.chain ?? 'solana'}
            loading={loading}
            error={activityError}
            showChainTag={isEvmAggregated}
          />
        </div>
      </div>

      <PnlChartModal
        open={chartOpen}
        onClose={() => setChartOpen(false)}
        data={pnlData}
        loading={pnlLoading}
        error={pnlError}
      />
      <PnlCalendarModal
        open={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        data={pnlData}
        loading={pnlLoading}
        error={pnlError}
      />
    </div>
  );
}
