import { useEffect, useState } from 'react';
import {
  Ban,
  Check,
  CircleAlert,
  CircleSlash,
  Loader,
  Lock,
  RefreshCw,
  Repeat,
  TriangleAlert,
} from 'lucide-react';
import { LP_BTN } from './styles';
import {
  ACTION_META,
  COMMAND_ACTIONS,
  actionAvailability,
  inFlightActionFor,
  presentCommand,
  shortTxHash,
  withNothingQueued,
  type CommandTone,
  type LpCommand,
  type LpCommandAction,
} from './commands';
import type { LpPositionView, PositionCoverage } from './positions';

/**
 * Manual compound / rebalance / exit.
 *
 * THESE BUTTONS DO NOT ACT. They append a row to a queue that a separate worker
 * process drains within a few seconds. Everything below is arranged so that is
 * impossible to misread:
 *
 *   - the button label while the POST is in flight is "Queueing…", not "Compounding…";
 *   - the moment it returns, a lifecycle strip appears reading "Compound queued —
 *     nothing has been sent on-chain", and the button goes disabled with that as
 *     its reason. There is no window in which the page looks idle-and-ready
 *     after a click, which is the window in which someone clicks twice;
 *   - only `done` with a transaction hash is ever rendered as an accomplished
 *     fact, and the hash is shown so it can be checked.
 *
 * An action the API would reject is disabled with the reason ON SCREEN — see
 * `actionAvailability`. Enabled-then-409 would teach the operator that the
 * buttons lie about what they can do.
 */

const TONE_FRAME: Record<CommandTone, string> = {
  queued: 'border-oct-yellow bg-oct-surface-raised',
  running: 'border-oct-accent bg-oct-accent-dim',
  done: 'border-oct-green bg-oct-surface-raised',
  failed: 'border-oct-flame bg-oct-surface-raised',
  skipped: 'border-oct-yellow bg-oct-surface-raised',
  unknown: 'border-oct-border-bright bg-oct-surface-raised',
};

const TONE_TEXT: Record<CommandTone, string> = {
  queued: 'text-oct-yellow',
  running: 'text-oct-accent',
  done: 'text-oct-green',
  failed: 'text-oct-flame',
  skipped: 'text-oct-yellow',
  unknown: 'text-oct-muted',
};

function ToneIcon({ tone }: { tone: CommandTone }) {
  const className = `${TONE_TEXT[tone]} shrink-0`;
  switch (tone) {
    case 'queued':
      return <Loader size={13} strokeWidth={2.5} className={className} />;
    case 'running':
      return <Loader size={13} strokeWidth={2.5} className={`${className} animate-spin`} />;
    case 'done':
      return <Check size={13} strokeWidth={2.5} className={className} />;
    case 'failed':
      return <TriangleAlert size={13} strokeWidth={2.5} className={className} />;
    case 'skipped':
      return <CircleSlash size={13} strokeWidth={2.5} className={className} />;
    default:
      return <CircleAlert size={13} strokeWidth={2.5} className={className} />;
  }
}

function ActionIcon({ action }: { action: LpCommandAction }) {
  if (action === 'compound') return <RefreshCw size={12} strokeWidth={2.5} />;
  if (action === 'rebalance') return <Repeat size={12} strokeWidth={2.5} />;
  return <Ban size={12} strokeWidth={2.5} />;
}

/** The live command, in the words of what has and has not happened yet. */
function LifecycleStrip({ command }: { command: LpCommand }) {
  const presentation = presentCommand(command);
  const hash = shortTxHash(presentation.txHash);

  return (
    <div className={`border-2 px-3 py-2.5 ${TONE_FRAME[presentation.tone]}`}>
      <div className="flex items-start gap-2 min-w-0">
        <span className="mt-0.5">
          <ToneIcon tone={presentation.tone} />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={`font-mono text-[11px] uppercase tracking-[0.12em] font-semibold ${
              TONE_TEXT[presentation.tone]
            }`}
          >
            {presentation.headline}
          </p>
          <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1">{presentation.detail}</p>

          {hash && (
            <p className="font-mono text-[10px] text-oct-text mt-1.5 break-all">
              <span className="uppercase tracking-[0.12em] text-oct-muted">tx</span> {hash}
            </p>
          )}

          {/* The queue steps, drawn rather than described, so "where is this
              now" is answerable without reading the paragraph. */}
          <div className="flex items-center gap-1.5 mt-2 font-mono text-[9px] uppercase tracking-[0.12em]">
            <Step label="Queued" active reached />
            <Rule />
            <Step
              label="Running"
              active={presentation.tone === 'running'}
              reached={presentation.tone !== 'queued'}
            />
            <Rule />
            <Step
              label={presentation.tone === 'failed' ? 'Failed' : presentation.tone === 'skipped' ? 'Skipped' : 'Done'}
              active={!presentation.inFlight}
              reached={!presentation.inFlight}
              tone={presentation.tone}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Rule() {
  return <span className="flex-1 h-px bg-oct-border-bright" aria-hidden />;
}

function Step({
  label,
  active,
  reached,
  tone,
}: {
  label: string;
  active: boolean;
  reached: boolean;
  tone?: CommandTone;
}) {
  const colour = !reached
    ? 'text-oct-muted border-oct-border'
    : tone === 'failed'
      ? 'text-oct-flame border-oct-flame'
      : tone === 'skipped'
        ? 'text-oct-yellow border-oct-yellow'
        : tone === 'done'
          ? 'text-oct-green border-oct-green'
          : 'text-oct-text border-oct-border-bright';
  return (
    <span className={`border px-1.5 py-0.5 whitespace-nowrap ${colour} ${active ? 'font-semibold' : ''}`}>
      {label}
    </span>
  );
}

export interface LpPositionActionsProps {
  position: LpPositionView;
  coverage: PositionCoverage;
  /** Commands for THIS position, newest first. */
  commands: LpCommand[];
  /** The action whose POST is in flight — the request, not the queued command. */
  submitting: LpCommandAction | null;
  submitError: string | null;
  /** The server's 409 text, if the client's model drifted from its. */
  conflict: string | null;
  apiUnavailable: boolean;
  onSubmit: (action: LpCommandAction) => void;
}

export default function LpPositionActions({
  position,
  coverage,
  commands,
  submitting,
  submitError,
  conflict,
  apiUnavailable,
  onSubmit,
}: LpPositionActionsProps) {
  // Exit is one-way, so it takes two clicks. Not a modal — a modal here would be
  // one more thing to dismiss reflexively.
  const [confirming, setConfirming] = useState<LpCommandAction | null>(null);

  // A different position means a different confirmation. Without this, arming
  // Exit and then switching positions would leave the next one armed.
  useEffect(() => {
    setConfirming(null);
  }, [position.tokenId]);

  const inFlight = inFlightActionFor(commands, position.tokenId);
  const latest = commands[0] ?? null;

  return (
    <div className="space-y-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted">Manual actions</p>
        <p className="font-mono text-[11px] text-oct-muted leading-relaxed mt-1">
          These queue an instruction for the signer process. Nothing is signed or broadcast from this page —
          the worker picks the instruction up within a few seconds and reports back below.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {COMMAND_ACTIONS.map((action) => {
          const meta = ACTION_META[action];
          const availability = actionAvailability({ action, coverage, inFlight, apiUnavailable });
          const isSubmitting = submitting === action;
          const armed = confirming === action;
          const disabled = !availability.enabled || submitting !== null;

          return (
            <div key={action} className="min-w-0 flex flex-col gap-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (meta.destructive && !armed) {
                    setConfirming(action);
                    return;
                  }
                  setConfirming(null);
                  onSubmit(action);
                }}
                className={`${LP_BTN} w-full ${
                  armed
                    ? 'border-oct-flame bg-oct-flame text-white'
                    : meta.destructive
                      ? 'border-oct-flame text-oct-flame hover:bg-oct-flame hover:text-white'
                      : 'border-oct-accent text-oct-accent hover:bg-oct-accent hover:text-white hover:border-oct-accent'
                }`}
              >
                {isSubmitting ? (
                  <Loader size={12} strokeWidth={2.5} className="animate-spin" />
                ) : !availability.enabled ? (
                  <Lock size={12} strokeWidth={2.5} />
                ) : (
                  <ActionIcon action={action} />
                )}
                {/* "Queueing…", never "Compounding…" — the request being in
                    flight is not the action being in flight. */}
                {isSubmitting ? 'Queueing…' : armed ? `Confirm ${meta.noun}` : meta.label}
              </button>

              {armed && (
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="font-mono text-[10px] uppercase tracking-[0.12em] text-oct-muted hover:text-oct-text underline"
                >
                  Cancel
                </button>
              )}

              <p
                className={`font-mono text-[10px] leading-relaxed ${
                  availability.enabled ? 'text-oct-muted' : 'text-oct-yellow'
                }`}
              >
                {availability.reason ?? meta.description}
              </p>
            </div>
          );
        })}
      </div>

      {/* A refusal is not a lifecycle state — nothing was enqueued, so no
          command exists to report on. Shown apart from the strip below for
          exactly that reason. */}
      {conflict && (
        <p className="font-mono text-[11px] text-oct-flame leading-relaxed border-2 border-oct-flame bg-oct-surface-raised px-3 py-2">
          The server refused this: {withNothingQueued(conflict)}
        </p>
      )}

      {submitError && (
        <p className="font-mono text-[11px] text-oct-flame leading-relaxed border-2 border-oct-flame bg-oct-surface-raised px-3 py-2">
          {withNothingQueued(submitError)}
        </p>
      )}

      {latest && <LifecycleStrip command={latest} />}

      {commands.length > 1 && (
        <details className="border-2 border-oct-border bg-oct-surface-raised">
          <summary className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-oct-muted cursor-pointer select-none">
            Earlier actions ({commands.length - 1})
          </summary>
          <ul className="border-t-2 border-oct-border divide-y divide-oct-border">
            {commands.slice(1).map((command) => {
              const presentation = presentCommand(command);
              const hash = shortTxHash(presentation.txHash);
              return (
                <li key={command.id} className="px-3 py-2 flex items-start justify-between gap-3 min-w-0">
                  <div className="min-w-0">
                    <p className={`font-mono text-[10px] uppercase tracking-[0.12em] ${TONE_TEXT[presentation.tone]}`}>
                      {presentation.headline}
                    </p>
                    {hash && <p className="font-mono text-[10px] text-oct-muted mt-0.5 break-all">{hash}</p>}
                    {presentation.tone === 'failed' && presentation.error && (
                      <p className="font-mono text-[10px] text-oct-muted mt-0.5 leading-relaxed">
                        {presentation.error}
                      </p>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-oct-muted shrink-0 tabular-nums">
                    {formatWhen(command.completedAt ?? command.requestedAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '—';
  return new Date(time).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
