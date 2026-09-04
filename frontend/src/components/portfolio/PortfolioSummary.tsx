import type { PortfolioStats } from '../../types/portfolio';
import { formatPercentRatio, formatUsd, toNumber } from '../../types/portfolio';
import { cn } from '../../lib/utils';

interface PortfolioSummaryProps {
  stats: PortfolioStats | null;
  totalHoldingsUsd: number;
  loading: boolean;
}

// `type-metric` rather than the legacy `.oct-stat-value`: the legacy helper sits
// in the utilities layer and would beat any `text-*` override, and its 10.5px
// label sibling is below the 12px floor. Colour is semantic — a positive figure
// is `oct-good`, a negative one `oct-critical` — never the brand accent, which
// in the dark theme is itself a red and would make a loss look like a button.
function StatCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  return (
    <div className="oct-stat-tile min-w-[140px] flex-1">
      <p className="type-caption font-mono uppercase tracking-[0.12em] text-oct-muted mb-tight">{label}</p>
      <p
        className={cn(
          'type-metric',
          positive === true ? 'text-oct-good' : positive === false ? 'text-oct-critical' : 'text-oct-text',
        )}
      >
        {value}
      </p>
      {sub && <p className="type-data text-oct-muted mt-tight">{sub}</p>}
    </div>
  );
}

export default function PortfolioSummary({ stats, totalHoldingsUsd, loading }: PortfolioSummaryProps) {
  if (loading && !stats) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-cozy">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[76px] rounded-oct border border-oct-border bg-oct-surface/50 animate-pulse" />
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
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-cozy">
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
