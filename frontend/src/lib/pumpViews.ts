// The pump.fun tab's sub-view registry, kept in a pure module (no React) so the
// tab list and the ?view= parser are unit-testable the way lib/routes.ts is —
// importing this into a test must not drag in the page component tree.
//
// Adding a view here is the single edit that "registers" a sub-tab: PumpfunPage
// renders PUMP_TABS and routes on parsePumpView, so the test that asserts
// 'leaderboard' is present guards against a tab that renders but never resolves.

export type PumpView = 'traders' | 'token' | 'trending' | 'leaderboard' | 'top-callers' | 'following';

export interface PumpTab {
  id: PumpView;
  label: string;
}

export const PUMP_TABS: readonly PumpTab[] = [
  { id: 'traders', label: 'Traders' },
  { id: 'token', label: 'Token' },
  { id: 'trending', label: 'Trending' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'top-callers', label: 'Top Callers' },
  { id: 'following', label: 'Following' },
] as const;

/** The default view when ?view= is absent or unrecognized. */
export const DEFAULT_PUMP_VIEW: PumpView = 'traders';

/**
 * Resolve a raw ?view= value to a known view, defaulting to Traders. Kept in sync
 * with PUMP_TABS: any id in the tab list must parse back to itself, or a tab
 * would highlight while the page fell through to the default panel.
 */
export function parsePumpView(raw: string | null): PumpView {
  if (
    raw === 'token' ||
    raw === 'trending' ||
    raw === 'leaderboard' ||
    raw === 'top-callers' ||
    raw === 'following'
  ) {
    return raw;
  }
  return DEFAULT_PUMP_VIEW;
}
