import { useEffect, useRef } from 'react';
import { Check, X, ArrowRight } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthSession } from '../../hooks/useAuthSession';
import { useTrackedWallets } from '../../hooks/useTrackedWallets';
import { useHoldingWallets } from '../../hooks/useHoldingWallets';
import { useActivationSteps } from '../../hooks/useActivation';
import { useAppStore } from '../../stores/appStore';
import { isHostedMode } from '../../lib/supabase';
import { track } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { fadeInUp, m, MotionFeatures, useStagger, useTransition } from '../../lib/motion';
import { countDone, nextStep, type ActivationStep } from '../../lib/activation';
import { useChecklistDismissal } from './useChecklistDismissal';

// ── First-run checklist ───────────────────────────────────────────────────────
// Mounted once, on the Dashboard home, for a user who has not yet reached a
// first signal. Four steps in dependency order, each ticked from live store
// state (so doing the step anywhere in the console ticks it here) and each a
// deep link to the surface where it is done. Dismissible; the dismissal is
// per-user (see useChecklistDismissal).
//
// It renders nothing when: not signed in (hosted), auth status still loading
// (would flash "connect" for a connected user), dismissed, or every step done.
//
// Instrumentation: `onboarding_checklist_shown` once per mount,
// `onboarding_step_clicked` per click, `onboarding_checklist_dismissed`. Props
// are step ids and counts only — no room names, handles or addresses, per the
// privacy posture in lib/analytics.ts.

export default function ActivationChecklist() {
  const { isAuthenticated, userId } = useAuthSession();
  const authLoading = useAppStore((s) => s.authLoading);
  const authStatus = useAppStore((s) => s.authStatus);
  const { dismissed, dismiss } = useChecklistDismissal();

  // Both hooks are inert without a userId (local mode), returning [] — which is
  // the correct answer there: those tables do not exist outside Supabase.
  const tracked = useTrackedWallets(userId);
  const holding = useHoldingWallets(userId);
  const steps = useActivationSteps({
    trackedWalletCount: tracked.wallets.length,
    holdingWalletCount: holding.wallets.length,
  });

  const done = countDone(steps);
  const next = nextStep(steps);
  const visible =
    isAuthenticated && !dismissed && next !== null && !(authLoading && authStatus === null);

  // Fire once per mount, and only once the list is actually on screen.
  const shownRef = useRef(false);
  useEffect(() => {
    if (!visible || shownRef.current) return;
    shownRef.current = true;
    track('onboarding_checklist_shown', {
      steps_done: done,
      next_step: next?.id ?? 'none',
      mode: isHostedMode ? 'hosted' : 'local',
    });
    // `done`/`next` deliberately left out: the event describes the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const stagger = useStagger();
  const transition = useTransition('snappy');

  // `next` is re-checked for TS narrowing; `visible` already implies it.
  if (!visible || !next) return null;

  const handleDismiss = () => {
    track('onboarding_checklist_dismissed', { steps_done: done });
    dismiss();
  };

  return (
    <MotionFeatures>
      <m.section
        variants={stagger}
        initial="hidden"
        animate="visible"
        aria-label="Getting started"
        className="oct-card p-roomy mb-section"
      >
        <m.div variants={fadeInUp} transition={transition} className="flex items-start justify-between gap-roomy mb-comfy">
          <div>
            <p className="type-caption font-mono uppercase tracking-[0.2em] text-oct-muted mb-tight">
              [ Getting started ] · {done}/{steps.length}
            </p>
            <h2 className="type-title text-oct-text tracking-tight">
              {done === 0 ? 'Nothing is streaming yet.' : `Next: ${next.label.toLowerCase()}`}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss getting-started checklist"
            title="Dismiss"
            className="shrink-0 p-tight rounded-oct-sm text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised transition-colors"
          >
            <X size={16} />
          </button>
        </m.div>

        <ol className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-cozy">
          {steps.map((step, i) => (
            <m.li key={step.id} variants={fadeInUp} transition={transition} className="min-w-0">
              <StepCard step={step} index={i} isNext={step.id === next.id} />
            </m.li>
          ))}
        </ol>
      </m.section>
    </MotionFeatures>
  );
}

function StepCard({ step, index, isNext }: { step: ActivationStep; index: number; isNext: boolean }) {
  const navigate = useNavigate();
  const openConfigModal = useAppStore((s) => s.openConfigModal);
  const firstRoom = useAppStore((s) => s.rooms[0]);

  const onClick = () => {
    track('onboarding_step_clicked', { step: step.id, done: step.done });
  };

  // Two steps end in a modal, not a page. Navigate to Feed first so the modal
  // closes onto the surface it configures, then open it — the modal is mounted
  // in AppProviders, so it survives the route change.
  const modalStep =
    step.id === 'room'
      ? () => openConfigModal()
      : step.id === 'watch' && !isHostedMode
        ? () => (firstRoom ? openConfigModal(firstRoom, 'users') : openConfigModal())
        : null;

  const className = cn(
    'group flex h-full items-start gap-comfy rounded-oct border px-comfy py-cozy text-left transition-colors',
    step.done
      ? 'border-oct-border bg-oct-surface-raised/40'
      : isNext
        ? 'border-oct-accent/60 bg-oct-surface-raised hover:border-oct-accent'
        : 'border-oct-border hover:border-oct-border-bright',
  );

  const content = (
    <>
      <span
        className={cn(
          'mt-hair flex h-5 w-5 shrink-0 items-center justify-center rounded-full border type-caption font-mono tabular-nums',
          step.done
            ? 'border-oct-good bg-oct-good text-black'
            : isNext
              ? 'border-oct-accent text-oct-accent'
              : 'border-oct-border text-oct-muted',
        )}
      >
        {step.done ? <Check size={12} strokeWidth={3} /> : index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block type-label',
            step.done ? 'text-oct-muted line-through decoration-oct-border-bright' : 'text-oct-text',
          )}
        >
          {step.label}
        </span>
        <span className="block type-caption text-oct-muted leading-snug mt-hair">{step.detail}</span>
      </span>
      {!step.done && (
        <ArrowRight
          size={14}
          className={cn(
            'mt-hair shrink-0 transition-transform group-hover:translate-x-0.5',
            isNext ? 'text-oct-accent' : 'text-oct-muted',
          )}
        />
      )}
    </>
  );

  if (modalStep) {
    return (
      <button
        type="button"
        className={cn(className, 'w-full')}
        onClick={() => {
          onClick();
          navigate(step.to);
          modalStep();
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <Link to={step.to} className={className} onClick={onClick}>
      {content}
    </Link>
  );
}
