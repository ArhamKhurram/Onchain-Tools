import type { WalletActivityItem } from './gmgnWallet.js';
import { classifyActivitySide } from './activityUtils.js';

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
  skippedUnknownType: number;
};

function toUsd(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function activityUsd(item: WalletActivityItem): number {
  const cost = Math.abs(toUsd(item.cost_usd));
  if (cost > 0) return cost;
  const amt = toUsd(item.token_amount);
  const price = toUsd(item.price_usd);
  if (amt > 0 && price > 0) return amt * price;
  return 0;
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
  let skippedUnknownType = 0;

  for (const item of activities) {
    const ts = Number(item.timestamp);
    if (!Number.isFinite(ts) || ts < cutoffSec) continue;

    const side = classifyActivitySide(item);
    if (!side) {
      skippedUnknownType += 1;
      continue;
    }

    const usd = activityUsd(item);
    if (usd <= 0) continue;

    const date = utcDateKey(ts);
    const row = buckets.get(date) ?? { date, netPnl: 0, buyUsd: 0, sellUsd: 0, tradeCount: 0 };

    if (side === 'buy') {
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
    skippedUnknownType,
    note: 'Trade-based daily PnL from GMGN activity USD (buys negative, sells positive). Not an official equity curve.',
  };
}
