import { Loader, Lock, RefreshCw, Repeat, Zap } from 'lucide-react';
import { LP_BTN } from './styles';
import {
  ACTION_META,
  actionAvailability,
  inFlightActionFor,
  type LpCommand,
  type LpCommandAction,
} from './commands';
import type { PositionCoverage } from './positions';

/** Row-level manual actions — compound, rebalance, compound+rebalance only. Exit stays in the drawer. */
const QUICK_ACTIONS: readonly LpCommandAction[] = ['compound', 'rebalance', 'compound_rebalance'];

function ActionIcon({ action }: { action: LpCommandAction }) {
  if (action === 'compound') return <RefreshCw size={11} strokeWidth={2.5} />;
  if (action === 'compound_rebalance') return <Zap size={11} strokeWidth={2.5} />;
  return <Repeat size={11} strokeWidth={2.5} />;
}

export interface LpQuickActionsProps {
  tokenId: string;
  coverage: PositionCoverage;
  commands: readonly LpCommand[];
  submitting: LpCommandAction | null;
  apiUnavailable: boolean;
  onSubmit: (action: LpCommandAction) => void;
}

export default function LpQuickActions({
  tokenId,
  coverage,
  commands,
  submitting,
  apiUnavailable,
  onSubmit,
}: LpQuickActionsProps) {
  const inFlight = inFlightActionFor(commands, tokenId);

  return (
    <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {QUICK_ACTIONS.map((action) => {
        const meta = ACTION_META[action];
        const availability = actionAvailability({ action, coverage, inFlight, apiUnavailable });
        const isSubmitting = submitting === action;
        const disabled = !availability.enabled || submitting !== null;
        const shortLabel =
          action === 'compound_rebalance' ? 'C+R' : action === 'compound' ? 'Compound' : 'Rebalance';

        return (
          <button
            key={action}
            type="button"
            disabled={disabled}
            title={availability.reason ?? meta.description}
            onClick={() => onSubmit(action)}
            className={`${LP_BTN} px-2 py-1 text-[10px] border-oct-border-bright text-oct-muted hover:text-oct-text hover:border-oct-text disabled:opacity-40`}
          >
            {isSubmitting ? (
              <Loader size={11} className="animate-spin" />
            ) : !availability.enabled ? (
              <Lock size={11} />
            ) : (
              <ActionIcon action={action} />
            )}
            {isSubmitting ? '…' : shortLabel}
          </button>
        );
      })}
    </div>
  );
}
