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
  PORTFOLIO_ALL_WALLETS,
  setStoredPortfolioWalletId,
  usePortfolio,
  usePortfolioPnlDaily,
} from '../hooks/usePortfolio';
import { routes } from '../lib/routes';
import type { PortfolioPeriod } from '../types/portfolio';
import { aggregateDailyPnlFromActivity, formatPortfolioError, isEvmWalletChain } from '../types/portfolio';

export default function PortfolioPage() {
  const { isAuthenticated, ready, userId } = useAuthSession();
  const { wallets, loading: walletsLoading } = useHoldingWallets(userId);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(
    () => getStoredPortfolioWalletId() ?? PORTFOLIO_ALL_WALLETS,
  );
  const [period, setPeriod] = useState<PortfolioPeriod>('30d');
  const [chartOpen, setChartOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);

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
    isAllWallets,
    refresh,
    dedupedWallets,
  } = usePortfolio(wallets, selectedWalletId, period);

  const selectedWallet = useMemo(() => {
    if (selectedWalletId === PORTFOLIO_ALL_WALLETS) return null;
    return dedupedWallets.find((w) => w.id === selectedWalletId) ?? dedupedWallets[0] ?? null;
  }, [dedupedWallets, selectedWalletId]);

  useEffect(() => {
    if (dedupedWallets.length === 0) return;
    if (selectedWalletId === PORTFOLIO_ALL_WALLETS) return;
    const exists = dedupedWallets.some((w) => w.id === selectedWalletId);
    if (!exists) {
      const next = dedupedWallets.length > 1 ? PORTFOLIO_ALL_WALLETS : dedupedWallets[0].id;
      setSelectedWalletId(next);
      setStoredPortfolioWalletId(next);
    }
  }, [dedupedWallets, selectedWalletId]);

  const pnlEnabled = chartOpen || calendarOpen;
  const { data: pnlFetched, loading: pnlLoading, error: pnlError } = usePortfolioPnlDaily(
    wallets,
    selectedWalletId,
    period,
    pnlEnabled,
  );

  const pnlFromActivity = useMemo(
    () => aggregateDailyPnlFromActivity(activity, period),
    [activity, period],
  );

  const pnlData = useMemo(() => {
    if (pnlFetched && pnlFetched.days.length > 0) return pnlFetched;
    return pnlFromActivity;
  }, [pnlFetched, pnlFromActivity]);

  const handleWalletChange = (id: string) => {
    setSelectedWalletId(id);
    setStoredPortfolioWalletId(id);
  };

  const isEvmAggregated = selectedWallet ? isEvmWalletChain(selectedWallet.chain) : false;
  const pickerValue = selectedWalletId ?? (dedupedWallets.length > 1 ? PORTFOLIO_ALL_WALLETS : dedupedWallets[0]?.id ?? '');

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
        <p className="font-mono text-sm text-white/60">Unable to load account. Try signing in again.</p>
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
      <div className="shrink-0 px-4 sm:px-6 py-4 border-b-2 border-oct-accent/30 bg-gradient-to-r from-oct-accent/[0.06] to-transparent">
        <div className="flex flex-wrap items-end gap-4 justify-between">
          <div>
            <p className="font-mono text-[10px] tracking-[0.2em] text-oct-accent mb-1">[ PORTFOLIO ]</p>
            <h1 className="font-display text-2xl sm:text-3xl text-white tracking-tight">GMGN Wallet Dashboard</h1>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {dedupedWallets.length > 0 && (
              <PortfolioWalletPicker
                wallets={dedupedWallets}
                selectedId={pickerValue}
                onChange={handleWalletChange}
              />
            )}

            <div className="flex border-2 border-oct-accent/40">
              {(['7d', '30d'] as PortfolioPeriod[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={[
                    'font-mono text-[11px] uppercase px-3 py-2 transition-colors',
                    period === p ? 'bg-oct-accent text-black font-bold' : 'bg-black text-white/60 hover:text-white',
                  ].join(' ')}
                >
                  {p}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => refresh()}
              className="font-mono text-[11px] uppercase border-2 border-oct-accent/40 px-3 py-2 text-white/70 hover:text-white hover:border-oct-accent inline-flex items-center gap-1"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        <p className="font-mono text-xs text-white/50 mt-3">
          {isAllWallets ? (
            <span className="text-oct-accent font-semibold">All {dedupedWallets.length} wallets combined</span>
          ) : selectedWallet ? (
            <>
              {selectedWallet.label ? `${selectedWallet.label} · ` : ''}
              <span className="text-white/70">{selectedWallet.address}</span>
              {isEvmAggregated && (
                <span className="text-oct-accent"> · ETH · Base · BSC</span>
              )}
            </>
          ) : null}
          {' · '}
          <Link to={`${routes.wallets}?view=mine`} className="text-oct-accent hover:underline">
            Manage in My Wallets
          </Link>
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-5 space-y-5">
        {gmgnMissing && (
          <div className="border-2 border-amber-500/50 bg-amber-950/30 px-4 py-3 font-mono text-xs text-amber-200">
            Portfolio requires <code className="text-amber-100">GMGN_API_KEY</code> on the backend server (Railway).
          </div>
        )}

        {(statsError || activityError || holdingsError) && !gmgnMissing && (
          <div className="border-2 border-red-500/50 bg-red-950/30 px-4 py-3 font-mono text-xs text-red-200 flex items-center justify-between gap-3">
            <span>{formatPortfolioError(statsError ?? activityError ?? holdingsError)}</span>
            <button type="button" onClick={() => refresh()} className="text-oct-accent underline hover:no-underline">
              Retry
            </button>
          </div>
        )}

        <PortfolioSummary stats={stats} totalHoldingsUsd={totalHoldingsUsd} loading={loading} />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setChartOpen(true)}
            className="font-mono text-[11px] uppercase border-2 border-oct-accent/50 px-4 py-2 bg-oct-accent/10 text-white hover:bg-oct-accent hover:text-black inline-flex items-center gap-2 transition-colors"
          >
            <BarChart3 size={14} />
            PnL Chart
          </button>
          <button
            type="button"
            onClick={() => setCalendarOpen(true)}
            className="font-mono text-[11px] uppercase border-2 border-oct-accent/50 px-4 py-2 bg-oct-accent/10 text-white hover:bg-oct-accent hover:text-black inline-flex items-center gap-2 transition-colors"
          >
            <CalendarDays size={14} />
            PnL Calendar
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 min-h-0">
          <PortfolioHoldingsTable
            holdings={holdings}
            chain={selectedWallet?.chain ?? 'robinhood'}
            loading={loading}
            error={holdingsError}
            needsPrivateKey={holdingsNeedsKey}
            showChainTag={isEvmAggregated || isAllWallets}
            showWalletTag={isAllWallets}
          />
          <PortfolioActivityFeed
            activity={activity}
            chain={selectedWallet?.chain ?? 'robinhood'}
            loading={loading}
            error={activityError}
            showChainTag={isEvmAggregated || isAllWallets}
            showWalletTag={isAllWallets}
          />
        </div>
      </div>

      <PnlChartModal
        open={chartOpen}
        onClose={() => setChartOpen(false)}
        data={pnlData}
        loading={pnlLoading || (loading && pnlData.days.length === 0)}
        error={pnlError}
      />
      <PnlCalendarModal
        open={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        data={pnlData}
        loading={pnlLoading || (loading && pnlData.days.length === 0)}
        error={pnlError}
      />
    </div>
  );
}
