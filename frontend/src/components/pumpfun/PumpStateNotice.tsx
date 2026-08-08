import { PlugZap, RefreshCw, ServerCrash } from 'lucide-react';

// The two non-data states a KEYED pump.fun surface can be in, rendered inline so
// they degrade a single panel rather than the page:
//   - disabled: PUMPFUN_API_KEY is unset (503). This is a configuration state,
//     not a fault — the copy says the callouts integration is off and that
//     trades/PnL are unaffected, so an operator does not read it as broken.
//   - error (retryable): a 502 vendor/contract fault behind our gateway. Offers a
//     retry rather than a dead end (the honesty rule: handle a 502 with a retry,
//     not a crash).
interface PumpStateNoticeProps {
  disabled: boolean;
  error: string | null;
  retryable: boolean;
  onRetry: () => void;
  /** Which surface this covers, for the disabled-state copy (e.g. "callouts"). */
  surface: string;
}

export default function PumpStateNotice({ disabled, error, retryable, onRetry, surface }: PumpStateNoticeProps) {
  if (disabled) {
    return (
      <div className="flex items-start gap-2.5 px-4 py-3 border-2 border-oct-border rounded-cockpit bg-oct-surface/60">
        <PlugZap size={15} className="text-oct-yellow shrink-0 mt-0.5" strokeWidth={2.5} />
        <p className="font-mono text-[11px] leading-relaxed text-oct-muted">
          The pump.fun {surface} integration is not configured (no API key on the server), so this panel is empty.
          Wallet trades and PnL are keyless and keep working.
        </p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2.5 px-4 py-3 border-2 border-oct-flame/50 rounded-cockpit bg-oct-flame/10">
        <ServerCrash size={15} className="text-oct-flame shrink-0 mt-0.5" strokeWidth={2.5} />
        <div className="flex-1 min-w-0">
          <p className="font-mono text-[11px] leading-relaxed text-oct-text break-words">{error}</p>
          {retryable && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-cockpit text-[10px] font-mono font-bold uppercase border-2 border-oct-flame text-oct-flame hover:bg-oct-flame hover:text-white transition-colors"
            >
              <RefreshCw size={11} />
              retry
            </button>
          )}
        </div>
      </div>
    );
  }
  return null;
}
