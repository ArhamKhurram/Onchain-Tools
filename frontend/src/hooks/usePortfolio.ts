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
import { walletChainToPortfolioParam } from '../types/portfolio';

const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const PORTFOLIO_WALLET_KEY = 'oct-portfolio-selected-wallet-id';

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

export function usePortfolio(wallet: HoldingWallet | null, period: PortfolioPeriod) {
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
    if (!wallet) {
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

    const chain = walletChainToPortfolioParam(wallet.chain);
    const address = encodeURIComponent(wallet.address);

    const [statsRes, holdingsRes, activityRes] = await Promise.all([
      portfolioFetch<{ stats: PortfolioStats; period: PortfolioPeriod }>(
        `/portfolio/${chain}/${address}/stats?period=${period}`,
      ),
      portfolioFetch<{ holdings?: PortfolioHolding[] }>(
        `/portfolio/${chain}/${address}/holdings?limit=50`,
      ),
      portfolioFetch<{ activities?: PortfolioActivity[] }>(
        `/portfolio/${chain}/${address}/activity?limit=20`,
      ),
    ]);

    if (statsRes.ok) {
      setStats(statsRes.data.stats);
    } else {
      setStats(null);
      setStatsError(statsRes.error);
      if (statsRes.gmgnConfigured === false) setGmgnMissing(true);
    }

    if (holdingsRes.ok) {
      setHoldings(holdingsRes.data.holdings ?? []);
    } else {
      setHoldings([]);
      setHoldingsError(holdingsRes.error);
      setHoldingsNeedsKey(!!holdingsRes.needsPrivateKey);
      if (holdingsRes.gmgnConfigured === false) setGmgnMissing(true);
    }

    if (activityRes.ok) {
      setActivity(activityRes.data.activities ?? []);
    } else {
      setActivity([]);
      setActivityError(activityRes.error);
      if (activityRes.gmgnConfigured === false) setGmgnMissing(true);
    }

    setLoading(false);
  }, [wallet, period]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      refresh();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refresh]);

  const totalHoldingsUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + Number(h.usd_value ?? 0), 0),
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
    refresh,
  };
}

export function usePortfolioPnlDaily(
  wallet: HoldingWallet | null,
  period: PortfolioPeriod,
  enabled: boolean,
) {
  const [data, setData] = useState<DailyPnlResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPnl = useCallback(async () => {
    if (!wallet || !enabled) return;

    setLoading(true);
    setError(null);

    const chain = walletChainToPortfolioParam(wallet.chain);
    const address = encodeURIComponent(wallet.address);
    const result = await portfolioFetch<DailyPnlResponse>(
      `/portfolio/${chain}/${address}/pnl-daily?period=${period}`,
    );

    if (result.ok) {
      setData(result.data);
    } else {
      setData(null);
      setError(result.error);
    }
    setLoading(false);
  }, [wallet, period, enabled]);

  useEffect(() => {
    if (enabled) fetchPnl();
  }, [enabled, fetchPnl]);

  return { data, loading, error, refresh: fetchPnl };
}
