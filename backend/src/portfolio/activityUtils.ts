import type { WalletActivityItem } from './gmgnWallet.js';

export type ActivitySide = 'buy' | 'sell';

/** Normalize GMGN wallet_activity rows into buy/sell for PnL bucketing. */
export function classifyActivitySide(item: WalletActivityItem): ActivitySide | null {
  const raw = String(
    item.type ?? item.side ?? item.event_type ?? '',
  ).toLowerCase().replace(/[_\s-]/g, '');

  if (raw.includes('buy') || raw === 'transferin' || raw === 'add') return 'buy';
  if (raw.includes('sell') || raw === 'transferout' || raw === 'remove') return 'sell';

  const isBuy = item.is_buy;
  if (isBuy === true || isBuy === 'true' || isBuy === 1 || isBuy === '1') return 'buy';
  if (isBuy === false || isBuy === 'false' || isBuy === 0 || isBuy === '0') return 'sell';

  return null;
}

export function activityDisplayType(item: WalletActivityItem): ActivitySide | 'other' {
  return classifyActivitySide(item) ?? 'other';
}
