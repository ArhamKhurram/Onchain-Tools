import { Clock, PlugZap, RefreshCw, ServerCrash } from 'lucide-react';

// The non-data states a KEYED pump.fun surface can be in, rendered inline so they
// degrade a single panel rather than the page:
//   - disabled: PUMPFUN_API_KEY is unset (503). This is a configuration state,
//     not a fault — the copy says the callouts integration is off and that
//     trades/PnL are unaffected, so an operator does not read it as broken.
//   - rateLimited: the shared key is being paced (429). NOT an error — the panel
//     self-heals with automatic backoff, so the copy is calm ("retrying…") and
//     the raw endpoint/status string is never shown. A manual retry stays as a
//     fallback for when the automatic budget is spent.
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
  /** 429: the shared key is rate-limited. Renders the calm self-healing state. */
  rateLimited?: boolean;
  /** An automatic backoff retry is still pending (vs. the budget being spent). */
  retrying?: boolean;
}

export default function PumpStateNotice({ disabled, error, retryable, onRetry, surface, rateLimited, retrying }: PumpStateNoticeProps) {
  if (disabled) {
    return (
      <div className="flex items-start gap-2.5 px-4 py-3 rounded-oct border border-oct-yellow/30 bg-oct-yellow/[0.06]">
        <PlugZap size={16} className="text-oct-yellow shrink-0 mt-0.5" strokeWidth={2.5} />
        <p className="font-mono text-xs leading-relaxed text-oct-muted">
          The pump.fun {surface} integration is not configured (no API key on the server), so this panel is empty.
          Wallet trades and PnL are keyless and keep working.
        </p>
      </div>
    );
  }
  if (rateLimited) {
    return (
      <div className="flex items-start gap-2.5 px-4 py-3 rounded-oct border border-oct-yellow/30 bg-oct-yellow/[0.06]">
        <Clock size={16} className={`text-oct-yellow shrink-0 mt-0.5 ${retrying ? 'animate-pulse' : ''}`} strokeWidth={2.5} />
        <div className="flex-1 min-w-0">
          <p className="font-mono text-xs leading-relaxed text-oct-muted">
            {retrying
              ? `pump.fun is busy right now (rate limit) — retrying ${surface} automatically…`
              : `pump.fun is still rate-limiting ${surface}. Give it a moment, then retry.`}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold uppercase border border-oct-yellow/50 text-oct-yellow hover:bg-oct-yellow hover:text-oct-bg transition-colors"
          >
            <RefreshCw size={11} />
            retry now
          </button>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2.5 px-4 py-3 rounded-oct border border-oct-flame/40 bg-oct-flame/10">
        <ServerCrash size={16} className="text-oct-flame shrink-0 mt-0.5" strokeWidth={2.5} />
        <div className="flex-1 min-w-0">
          <p className="font-mono text-xs leading-relaxed text-oct-text break-words">{error}</p>
          {retryable && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold uppercase border border-oct-flame/60 text-oct-flame hover:bg-oct-flame hover:text-white transition-colors"
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
