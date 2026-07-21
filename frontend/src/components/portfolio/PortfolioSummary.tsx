import type { PortfolioStats } from '../../types/portfolio';
import { formatPercentRatio, formatUsd, toNumber } from '../../types/portfolio';

interface PortfolioSummaryProps {
  stats: PortfolioStats | null;
  totalHoldingsUsd: number;
  loading: boolean;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-2 border-black bg-oct-surface px-4 py-3 min-w-[140px] flex-1">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted mb-1">{label}</p>
      <p className="font-display text-xl text-oct-text tracking-tight">{value}</p>
      {sub && <p className="font-mono text-[10px] text-oct-muted mt-1">{sub}</p>}
    </div>
  );
}

export default function PortfolioSummary({ stats, totalHoldingsUsd, loading }: PortfolioSummaryProps) {
  if (loading && !stats) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[72px] border-2 border-black bg-oct-surface/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!stats) return null;

  const winrate = toNumber(stats.winrate);
  const pnlRatio = toNumber(stats.pnl);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
      <StatCard label="Realized PnL" value={formatUsd(stats.realized_profit, { signed: true })} />
      <StatCard label="Unrealized PnL" value={formatUsd(stats.unrealized_profit, { signed: true })} />
      <StatCard label="Win Rate" value={formatPercentRatio(winrate)} />
      <StatCard label="Total Spent" value={formatUsd(stats.total_cost)} />
      <StatCard
        label="Buys / Sells"
        value={`${toNumber(stats.buy_count)} / ${toNumber(stats.sell_count)}`}
      />
      <StatCard
        label="PnL Ratio"
        value={pnlRatio ? `${pnlRatio.toFixed(2)}×` : '—'}
        sub={totalHoldingsUsd > 0 ? `Holdings ~${formatUsd(totalHoldingsUsd)}` : undefined}
      />
    </div>
  );
}
