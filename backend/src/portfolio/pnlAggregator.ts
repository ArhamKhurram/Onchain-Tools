import type { WalletActivityItem } from './gmgnWallet.js';

export type DailyPnlDay = {
  date: string;
  netPnl: number;
  buyUsd: number;
  sellUsd: number;
  tradeCount: number;
};

export type DailyPnlCumulative = {
  date: string;
  cumulativePnl: number;
};

export type DailyPnlResult = {
  days: DailyPnlDay[];
  cumulative: DailyPnlCumulative[];
  note: string;
};

function toUsd(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function utcDateKey(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toISOString().slice(0, 10);
}

export function aggregateDailyPnl(
  activities: WalletActivityItem[],
  periodDays: 7 | 30 = 30,
): DailyPnlResult {
  const cutoffSec = Math.floor(Date.now() / 1000) - periodDays * 86_400;
  const buckets = new Map<string, DailyPnlDay>();

  for (const item of activities) {
    const ts = Number(item.timestamp);
    if (!Number.isFinite(ts) || ts < cutoffSec) continue;

    const type = String(item.type ?? '').toLowerCase();
    if (type !== 'buy' && type !== 'sell') continue;

    const usd = Math.abs(toUsd(item.cost_usd));
    const date = utcDateKey(ts);
    const row = buckets.get(date) ?? { date, netPnl: 0, buyUsd: 0, sellUsd: 0, tradeCount: 0 };

    if (type === 'buy') {
      row.buyUsd += usd;
      row.netPnl -= usd;
    } else {
      row.sellUsd += usd;
      row.netPnl += usd;
    }
    row.tradeCount += 1;
    buckets.set(date, row);
  }

  const days = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));

  let running = 0;
  const cumulative: DailyPnlCumulative[] = days.map((day) => {
    running += day.netPnl;
    return { date: day.date, cumulativePnl: running };
  });

  return {
    days,
    cumulative,
    note: 'Trade-based daily PnL estimated from GMGN wallet activity (buy/sell USD).',
  };
}
