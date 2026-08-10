import type { PortfolioStats } from '../../types/portfolio';
import { formatPercentRatio, formatUsd, toNumber } from '../../types/portfolio';

interface PortfolioSummaryProps {
  stats: PortfolioStats | null;
  totalHoldingsUsd: number;
  loading: boolean;
}

function StatCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  return (
    <div className="oct-stat-tile min-w-[140px] flex-1">
      <p className="oct-stat-label mb-1.5">{label}</p>
      <p
        className={[
          'oct-stat-value',
          positive === true ? 'text-oct-green' : positive === false ? 'text-oct-flame' : 'text-oct-text',
        ].join(' ')}
      >
        {value}
      </p>
      {sub && <p className="font-mono text-[11px] text-oct-muted mt-1.5">{sub}</p>}
    </div>
  );
}

export default function PortfolioSummary({ stats, totalHoldingsUsd, loading }: PortfolioSummaryProps) {
  if (loading && !stats) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[84px] rounded-oct border border-oct-border bg-oct-surface/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!stats) return null;

  const winrate = toNumber(stats.winrate);
  const pnlRatio = toNumber(stats.pnl);
  const realized = toNumber(stats.realized_profit);
  const unrealized = toNumber(stats.unrealized_profit);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
      <StatCard
        label="Realized PnL"
        value={formatUsd(stats.realized_profit, { signed: true })}
        positive={realized > 0 ? true : realized < 0 ? false : undefined}
      />
      <StatCard
        label="Unrealized PnL"
        value={formatUsd(stats.unrealized_profit, { signed: true })}
        positive={unrealized > 0 ? true : unrealized < 0 ? false : undefined}
      />
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
