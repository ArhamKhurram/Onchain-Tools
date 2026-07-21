import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAccessToken } from '../lib/supabase';
import type { HoldingWallet } from '../types/holdingWallets';
import type {
  DailyPnlResponse,
  PortfolioActivity,
  PortfolioApiError,
  PortfolioHolding,
  PortfolioPeriod,
  PortfolioStats,
} from '../types/portfolio';
import {
  dedupeHoldingWallets,
  mergeDailyPnl,
  mergePortfolioStats,
  walletChainToPortfolioParam,
} from '../types/portfolio';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const PORTFOLIO_WALLET_KEY = 'oct-portfolio-selected-wallet-id';
export const PORTFOLIO_ALL_WALLETS = '__all__';

async function portfolioFetch<T>(path: string): Promise<{ ok: true; data: T } | PortfolioApiError> {
  const headers = new Headers({ Accept: 'application/json' });
  const token = await getAccessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { headers });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    return {
      ok: false,
      error: body.error ?? `Request failed (${res.status})`,
      needsPrivateKey: body.needsPrivateKey,
      gmgnConfigured: body.gmgnConfigured,
    };
  }

  return { ok: true, data: body as T };
}

export function getStoredPortfolioWalletId(): string | null {
  try {
    return localStorage.getItem(PORTFOLIO_WALLET_KEY);
  } catch {
    return null;
  }
}

export function setStoredPortfolioWalletId(id: string | null): void {
  try {
    if (id) localStorage.setItem(PORTFOLIO_WALLET_KEY, id);
    else localStorage.removeItem(PORTFOLIO_WALLET_KEY);
  } catch {
    /* ignore */
  }
}

function walletLabel(w: HoldingWallet): string {
  return w.label.trim() || `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
}

async function fetchOneWallet(
  wallet: HoldingWallet,
  period: PortfolioPeriod,
  opts: { activityLimit: number; tagLabel: boolean },
) {
  const chain = walletChainToPortfolioParam(wallet.chain);
  const address = encodeURIComponent(wallet.address);
  const label = walletLabel(wallet);

  const [statsRes, holdingsRes, activityRes] = await Promise.all([
    portfolioFetch<{ stats: PortfolioStats; period: PortfolioPeriod }>(
      `/portfolio/${chain}/${address}/stats?period=${period}`,
    ),
    portfolioFetch<{ holdings?: PortfolioHolding[] }>(
      `/portfolio/${chain}/${address}/holdings?limit=50`,
    ),
    portfolioFetch<{ activities?: PortfolioActivity[] }>(
      `/portfolio/${chain}/${address}/activity?limit=${opts.activityLimit}`,
    ),
  ]);

  const tag = <T extends PortfolioHolding | PortfolioActivity>(rows: T[]): T[] =>
    opts.tagLabel ? rows.map((r) => ({ ...r, walletLabel: label })) : rows;

  return {
    wallet,
    statsRes,
    holdings: tag(holdingsRes.ok ? (holdingsRes.data.holdings ?? []) : []),
    activity: tag(activityRes.ok ? (activityRes.data.activities ?? []) : []),
    holdingsRes,
    activityRes,
  };
}

export function usePortfolio(
  allWallets: HoldingWallet[],
  selectedId: string | null,
  period: PortfolioPeriod,
) {
  const deduped = useMemo(() => dedupeHoldingWallets(allWallets), [allWallets]);

  const targets = useMemo(() => {
    if (deduped.length === 0) return [];
    if (selectedId === PORTFOLIO_ALL_WALLETS) return deduped;
    const one = deduped.find((w) => w.id === selectedId) ?? deduped[0];
    return one ? [one] : [];
  }, [deduped, selectedId]);

  const isAllWallets = selectedId === PORTFOLIO_ALL_WALLETS && deduped.length > 1;
  const activityLimit = isAllWallets ? 30 : 50;

  const [stats, setStats] = useState<PortfolioStats | null>(null);
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [activity, setActivity] = useState<PortfolioActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [holdingsNeedsKey, setHoldingsNeedsKey] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [gmgnMissing, setGmgnMissing] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (targets.length === 0) {
      setStats(null);
      setHoldings([]);
      setActivity([]);
      setStatsError(null);
      setHoldingsError(null);
      setActivityError(null);
      setHoldingsNeedsKey(false);
      setGmgnMissing(false);
      return;
    }

    setLoading(true);
    setStatsError(null);
    setHoldingsError(null);
    setActivityError(null);
    setHoldingsNeedsKey(false);
    setGmgnMissing(false);

    const results = await Promise.all(
      targets.map((w) => fetchOneWallet(w, period, { activityLimit, tagLabel: isAllWallets })),
    );

    const statsList: PortfolioStats[] = [];
    for (const r of results) {
      if (r.statsRes.ok) statsList.push(r.statsRes.data.stats);
    }
    if (statsList.length > 0) {
      setStats(mergePortfolioStats(statsList));
    } else {
      setStats(null);
      const fail = results.find((r) => !r.statsRes.ok);
      setStatsError(fail && !fail.statsRes.ok ? fail.statsRes.error : 'Failed to load stats.');
      if (results.some((r) => !r.statsRes.ok && r.statsRes.gmgnConfigured === false)) setGmgnMissing(true);
    }

    const allHoldings = results.flatMap((r) => r.holdings).sort((a, b) => toNum(b.usd_value) - toNum(a.usd_value));
    setHoldings(allHoldings);

    const holdingsFails = results.filter((r) => !r.holdingsRes.ok);
    if (holdingsFails.length === results.length) {
      const first = holdingsFails[0];
      setHoldingsError(first && !first.holdingsRes.ok ? first.holdingsRes.error : 'Failed to load holdings.');
      setHoldingsNeedsKey(holdingsFails.some((r) => !r.holdingsRes.ok && r.holdingsRes.needsPrivateKey));
    } else if (holdingsFails.some((r) => !r.holdingsRes.ok && r.holdingsRes.needsPrivateKey)) {
      setHoldingsNeedsKey(true);
    }
    if (holdingsFails.some((r) => !r.holdingsRes.ok && r.holdingsRes.gmgnConfigured === false)) setGmgnMissing(true);

    const allActivity = results
      .flatMap((r) => r.activity)
      .sort((a, b) => toNum(b.timestamp) - toNum(a.timestamp))
      .slice(0, isAllWallets ? 50 : activityLimit);
    setActivity(allActivity);

    const activityFails = results.filter((r) => !r.activityRes.ok);
    if (activityFails.length === results.length) {
      const first = activityFails[0];
      setActivityError(first && !first.activityRes.ok ? first.activityRes.error : 'Failed to load activity.');
      if (activityFails.some((r) => !r.activityRes.ok && r.activityRes.gmgnConfigured === false)) setGmgnMissing(true);
    }

    setLoading(false);
  }, [targets, period, activityLimit, isAllWallets]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refresh, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refresh]);

  const totalHoldingsUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + toNum(h.usd_value), 0),
    [holdings],
  );

  return {
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
    dedupedWallets: deduped,
  };
}

function toNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function usePortfolioPnlDaily(
  allWallets: HoldingWallet[],
  selectedId: string | null,
  period: PortfolioPeriod,
  enabled: boolean,
) {
  const deduped = useMemo(() => dedupeHoldingWallets(allWallets), [allWallets]);

  const targets = useMemo(() => {
    if (deduped.length === 0) return [];
    if (selectedId === PORTFOLIO_ALL_WALLETS) return deduped;
    const one = deduped.find((w) => w.id === selectedId) ?? deduped[0];
    return one ? [one] : [];
  }, [deduped, selectedId]);

  const [data, setData] = useState<DailyPnlResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPnl = useCallback(async () => {
    if (!enabled || targets.length === 0) return;

    setLoading(true);
    setError(null);

    const responses = await Promise.all(
      targets.map(async (wallet) => {
        const chain = walletChainToPortfolioParam(wallet.chain);
        const address = encodeURIComponent(wallet.address);
        const result = await portfolioFetch<DailyPnlResponse>(
          `/portfolio/${chain}/${address}/pnl-daily?period=${period}`,
        );
        return result;
      }),
    );

    const ok: { ok: true; data: DailyPnlResponse }[] = [];
    for (const r of responses) {
      if (r.ok === true) ok.push(r);
    }
    if (ok.length === 0) {
      setData(null);
      setError(responses.find((r) => !r.ok)?.error ?? 'Failed to load PnL data.');
    } else {
      setData(mergeDailyPnl(ok.map((r) => r.data)));
    }
    setLoading(false);
  }, [targets, period, enabled]);

  useEffect(() => {
    if (enabled) fetchPnl();
  }, [enabled, fetchPnl]);

  return { data, loading, error, refresh: fetchPnl };
}
