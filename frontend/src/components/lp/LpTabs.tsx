import type { ReactNode } from 'react';

// Tab chrome for the LP page.
//
// The page has four jobs that are read at completely different frequencies:
// positions get checked daily, the policy is configured once and rarely
// revisited. Stacking them in one scroll made the daily thing sit below the
// rare thing. Tabs put the operational view first and demote configuration to
// where it belongs.
//
// THE ONE RULE THIS COMPONENT EXISTS TO ENFORCE: a tab must be able to shout.
// Validation errors and unsaved edits can be created in one tab and are saved
// by a bar that is always visible from every tab. If an error could hide behind
// an inactive tab, the operator would hit Save against a problem they cannot
// see and get a rejection with no visible cause. Hence `alert` — rendered in
// flame, and never suppressed by the tab being inactive.

export type LpTabId = 'positions' | 'pools' | 'policy' | 'history' | 'settings';

export interface LpTabDef {
  id: LpTabId;
  label: string;
  /** Neutral count — muted, purely informational. */
  badge?: string | number | null;
  /**
   * Something on this tab needs attention (a rejected field, an unsaved edit).
   * Rendered in flame and deliberately impossible to miss from another tab.
   */
  alert?: boolean;
}

interface LpTabsProps {
  tabs: readonly LpTabDef[];
  active: LpTabId;
  onSelect: (id: LpTabId) => void;
}

export default function LpTabs({ tabs, active, onSelect }: LpTabsProps) {
  return (
    <div role="tablist" aria-label="LP automation sections" className="flex items-stretch gap-0 -mb-0.5 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`lp-tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`lp-panel-${tab.id}`}
            onClick={() => onSelect(tab.id)}
            className={[
              'shrink-0 inline-flex items-center gap-2 px-4 py-2.5 border-b-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors',
              isActive
                ? 'border-oct-accent text-oct-text bg-oct-surface'
                : 'border-transparent text-oct-muted hover:text-oct-text hover:border-oct-border-bright',
            ].join(' ')}
          >
            <span>{tab.label}</span>

            {tab.badge !== null && tab.badge !== undefined && tab.badge !== '' && (
              <span
                className={[
                  'inline-flex items-center justify-center min-w-[1.25rem] px-1 py-0.5 border font-mono text-[10px] tabular-nums leading-none',
                  isActive
                    ? 'border-oct-accent text-oct-text'
                    : 'border-oct-border-bright text-oct-muted',
                ].join(' ')}
              >
                {tab.badge}
              </span>
            )}

            {/* Never conditioned on `isActive` — the entire point is that it is
                visible while you are looking at a different tab. */}
            {tab.alert && (
              <span
                aria-label="needs attention"
                title="Needs attention"
                className="inline-block w-1.5 h-1.5 rounded-full bg-oct-flame"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Wrapper that ties a panel to its tab for screen readers. */
export function LpTabPanel({
  id,
  active,
  children,
}: {
  id: LpTabId;
  active: LpTabId;
  children: ReactNode;
}) {
  if (id !== active) return null;
  return (
    <div role="tabpanel" id={`lp-panel-${id}`} aria-labelledby={`lp-tab-${id}`} className="space-y-4">
      {children}
    </div>
  );
}
