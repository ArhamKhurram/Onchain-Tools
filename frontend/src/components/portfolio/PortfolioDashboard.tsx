import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { BarChart3, CalendarDays, PieChart, Plus, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import ConsoleEmptyState from '../console/ConsoleEmptyState';
import ConfirmModal from '../ConfirmModal';
import HoldingWalletFormModal, { type HoldingWalletFormValues } from '../wallets/HoldingWalletFormModal';
import PortfolioActivityFeed from './PortfolioActivityFeed';
import PortfolioHoldingsTable from './PortfolioHoldingsTable';
import PortfolioSummary from './PortfolioSummary';
import PortfolioWalletPicker from './PortfolioWalletPicker';
import PnlCalendarModal from './PnlCalendarModal';
import FullPageSpinner from '../common/FullPageSpinner';
import { cn } from '../../lib/utils';
// The chart modal (hand-rolled SVG since the recharts removal) still loads
// lazily — a Portfolio visit doesn't pay for chart code until the chart opens.
const PnlChartModal = lazy(() => import('./PnlChartModal'));
import { useAuthSession } from '../../hooks/useAuthSession';
import { useHoldingWallets } from '../../hooks/useHoldingWallets';
import type { HoldingWallet } from '../../types/holdingWallets';
import {
  getStoredPortfolioWalletId,
  PORTFOLIO_ALL_WALLETS,
  setStoredPortfolioWalletId,
  usePortfolio,
  usePortfolioPnlDaily,
} from '../../hooks/usePortfolio';
import { routes } from '../../lib/routes';
import type { PortfolioPeriod } from '../../types/portfolio';
import { aggregateDailyPnlFromActivity, formatPortfolioError, isEvmWalletChain } from '../../types/portfolio';

export default function PortfolioDashboard() {
  const { isAuthenticated, ready, userId } = useAuthSession();
  const { wallets, loading: walletsLoading, createWallet, updateWallet, deleteWallet } =
    useHoldingWallets(userId);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(
    () => getStoredPortfolioWalletId() ?? PORTFOLIO_ALL_WALLETS,
  );
  const [period, setPeriod] = useState<PortfolioPeriod>('30d');
  const [chartOpen, setChartOpen] = useState(false);
  // The chart modal is a lazy chunk, so it is not mounted until first opened —
  // but once it has been, it STAYS mounted (closed) so AnimatePresence can play
  // its exit fade. Gating on `chartOpen` alone would tear it down mid-exit.
  const [chartMounted, setChartMounted] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  // Wallet management now lives here (formerly the Wallets → My Wallets tab):
  // add via the +, edit/remove the selected wallet. No separate list — the
  // picker is the list.
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add');
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<HoldingWallet | null>(null);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);

  const {
    stats,
    holdings,
    activity,
    loading,
    statsError,
    holdingsError,
    activityError,
    portfolioApiMissing,
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

  const openChart = () => {
    setChartMounted(true);
    setChartOpen(true);
  };

  const handleWalletChange = (id: string) => {
    setSelectedWalletId(id);
    setStoredPortfolioWalletId(id);
  };

  const openAddWallet = () => {
    setWalletActionError(null);
    setFormMode('add');
    setFormOpen(true);
  };

  const openEditWallet = () => {
    if (!selectedWallet) return;
    setWalletActionError(null);
    setFormMode('edit');
    setFormOpen(true);
  };

  const handleWalletSubmit = async (values: HoldingWalletFormValues) => {
    if (formMode === 'edit' && selectedWallet) {
      await updateWallet(selectedWallet.id, values);
    } else {
      const created = await createWallet(values);
      setSelectedWalletId(created.id);
      setStoredPortfolioWalletId(created.id);
    }
  };

  const handleWalletDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteWallet(deleteTarget.id);
      if (selectedWalletId === deleteTarget.id) {
        setSelectedWalletId(PORTFOLIO_ALL_WALLETS);
        setStoredPortfolioWalletId(PORTFOLIO_ALL_WALLETS);
      }
    } catch (err) {
      setWalletActionError(err instanceof Error ? err.message : 'Failed to remove wallet.');
    }
    setDeleteTarget(null);
  };

  const isEvmAggregated = selectedWallet ? isEvmWalletChain(selectedWallet.chain) : false;
  const pickerValue = selectedWalletId ?? (dedupedWallets.length > 1 ? PORTFOLIO_ALL_WALLETS : dedupedWallets[0]?.id ?? '');

  if (!ready) {
    return <FullPageSpinner />;
  }

  if (!isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={PieChart}
        eyebrow="[ PORTFOLIO ]"
        title="Sign in to view portfolio"
        description="Portfolio pulls Birdeye stats, holdings, and trade history for the buy wallets you save here."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  if (!userId) {
    return (
      <div className="flex items-center justify-center h-full p-section bg-oct-bg">
        <p className="type-body text-oct-muted">Unable to load account. Try signing in again.</p>
      </div>
    );
  }

  if (!walletsLoading && wallets.length === 0) {
    return (
      <>
        <ConsoleEmptyState
          icon={PieChart}
          eyebrow="[ PORTFOLIO ]"
          title="Add your first wallet"
          description="Portfolio tracks the buy wallets you save here. Add a SOL, Base, BSC, ETH, or Robinhood (HOOD) address to see holdings, PnL and activity."
          actionLabel="ADD WALLET"
          onActionClick={openAddWallet}
          secondaryLabel="← Back to console home"
          secondaryTo={routes.home}
        />
        <HoldingWalletFormModal
          open={formOpen}
          mode="add"
          onClose={() => setFormOpen(false)}
          onSubmit={handleWalletSubmit}
        />
      </>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg overflow-hidden">
      <div className="oct-headerbar shrink-0 px-roomy sm:px-section py-comfy">
        <div className="flex flex-wrap items-end gap-roomy justify-between">
          <div>
            <p className="type-caption font-mono uppercase tracking-[0.2em] text-oct-muted mb-tight">[ PORTFOLIO ]</p>
            <h1 className="font-display type-heading sm:type-display text-oct-text tracking-tight">Wallet Dashboard</h1>
            <p className="type-caption font-mono text-oct-muted mt-tight max-w-xl">
              Powered by Birdeye. GMGN is reserved for missed-runner alerts — Portfolio does not call GMGN.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-comfy">
            {dedupedWallets.length > 0 && (
              <div className="flex items-end gap-cozy">
                <PortfolioWalletPicker
                  wallets={dedupedWallets}
                  selectedId={pickerValue}
                  onChange={handleWalletChange}
                />
                <div className="flex gap-tight">
                  <button
                    type="button"
                    onClick={openAddWallet}
                    title="Add wallet"
                    className="oct-icon-btn px-cozy py-snug"
                  >
                    <Plus size={14} />
                  </button>
                  {selectedWallet && (
                    <>
                      <button
                        type="button"
                        onClick={openEditWallet}
                        title="Edit selected wallet"
                        className="oct-icon-btn px-cozy py-snug"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(selectedWallet)}
                        title="Remove selected wallet"
                        className="oct-icon-btn px-cozy py-snug hover:!text-oct-critical"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-tight p-hair rounded-oct border border-oct-border bg-oct-bg">
              {(['7d', '30d'] as PortfolioPeriod[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={cn(
                    'type-caption font-mono uppercase px-comfy py-snug rounded-oct-sm transition-all',
                    period === p
                      ? 'bg-oct-accent text-white font-bold shadow-oct-glow-accent'
                      : 'text-oct-muted hover:text-oct-text',
                  )}
                >
                  {p}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => refresh()}
              className="oct-icon-btn type-caption font-mono uppercase px-comfy py-snug"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        <p className="type-data text-oct-muted mt-cozy">
          {isAllWallets ? (
            <span className="text-oct-accent font-semibold">All {dedupedWallets.length} wallets combined</span>
          ) : selectedWallet ? (
            <>
              {selectedWallet.label ? `${selectedWallet.label} · ` : ''}
              <span className="text-oct-text">{selectedWallet.address}</span>
              {isEvmAggregated && (
                <span className="text-oct-accent"> · ETH · Base · BSC</span>
              )}
            </>
          ) : null}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-roomy sm:px-section py-roomy space-y-roomy">
        {portfolioApiMissing && (
          <div className="rounded-oct border border-oct-warn/50 bg-oct-warn-dim px-comfy py-cozy type-body text-oct-warn">
            Portfolio requires <code className="text-oct-text">BIRDEYE_API_KEY</code> on the backend server (Railway).
          </div>
        )}

        {!portfolioApiMissing && (
          <div className="rounded-oct border border-oct-accent/25 bg-oct-accent/[0.05] px-comfy py-cozy type-caption font-mono text-oct-muted leading-relaxed">
            <span className="text-oct-accent uppercase tracking-wider">Rate limits:</span>{' '}
            Birdeye Standard tier caps wallet API traffic (~5 req/s). All Wallets loads many requests — pick one wallet
            if data is slow or errors. Missed-runner alerts use GMGN separately and are unaffected.
          </div>
        )}

        {walletActionError && (
          <div className="rounded-oct border border-oct-critical/50 bg-oct-critical-dim px-comfy py-cozy type-body text-oct-critical flex items-center justify-between gap-comfy">
            <span>{walletActionError}</span>
            <button type="button" onClick={() => setWalletActionError(null)} className="type-label underline hover:no-underline">
              Dismiss
            </button>
          </div>
        )}

        {(statsError || activityError || holdingsError) && !portfolioApiMissing && (
          <div className="rounded-oct border border-oct-critical/50 bg-oct-critical-dim px-comfy py-cozy type-body text-oct-critical flex items-center justify-between gap-comfy">
            <span>{formatPortfolioError(statsError ?? activityError ?? holdingsError)}</span>
            <button type="button" onClick={() => refresh()} className="type-label underline hover:no-underline">
              Retry
            </button>
          </div>
        )}

        <PortfolioSummary stats={stats} totalHoldingsUsd={totalHoldingsUsd} loading={loading} />

        <div className="flex flex-wrap gap-cozy">
          <button
            type="button"
            onClick={openChart}
            className="oct-icon-btn type-caption font-mono uppercase px-comfy py-snug gap-cozy"
          >
            <BarChart3 size={14} />
            PnL Chart
          </button>
          <button
            type="button"
            onClick={() => setCalendarOpen(true)}
            className="oct-icon-btn type-caption font-mono uppercase px-comfy py-snug gap-cozy"
          >
            <CalendarDays size={14} />
            PnL Calendar
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-roomy min-h-0">
          <PortfolioHoldingsTable
            holdings={holdings}
            chain={selectedWallet?.chain ?? 'robinhood'}
            loading={loading}
            error={holdingsError}
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

      {chartMounted && (
        <Suspense fallback={null}>
          <PnlChartModal
            open={chartOpen}
            onClose={() => setChartOpen(false)}
            data={pnlData}
            loading={pnlLoading && pnlData.days.length === 0}
            error={pnlData.days.length === 0 ? pnlError : null}
          />
        </Suspense>
      )}
      <PnlCalendarModal
        open={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        data={pnlData}
        loading={pnlLoading && pnlData.days.length === 0}
        error={pnlData.days.length === 0 ? pnlError : null}
      />

      <HoldingWalletFormModal
        open={formOpen}
        mode={formMode}
        wallet={formMode === 'edit' ? selectedWallet : null}
        onClose={() => setFormOpen(false)}
        onSubmit={handleWalletSubmit}
      />
      <ConfirmModal
        open={!!deleteTarget}
        title="Remove wallet"
        message={
          deleteTarget
            ? `Remove ${deleteTarget.label?.trim() || deleteTarget.address} from your portfolio? This only stops tracking it here.`
            : ''
        }
        confirmLabel="Remove"
        onConfirm={handleWalletDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
