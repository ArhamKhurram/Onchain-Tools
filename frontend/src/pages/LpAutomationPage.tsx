import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Beaker, Check, RefreshCw, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import ConsoleEmptyState from '../components/console/ConsoleEmptyState';
import LpIdleNotice from '../components/lp/LpIdleNotice';
import LpPolicyEditor from '../components/lp/LpPolicyEditor';
import LpPoolPicker from '../components/lp/LpPoolPicker';
import LpSafetyStrip from '../components/lp/LpSafetyStrip';
import LpVersionHistory from '../components/lp/LpVersionHistory';
import {
  DEFAULT_POLICY_DRAFT,
  draftFromPolicy,
  draftToPayload,
  draftsEqual,
  issuesByField,
  toNumber,
  validatePolicyDraft,
  type PolicyDraft,
} from '../components/lp/policyDraft';
import { summarizeAllowlist } from '../components/lp/selection';
import { LP_BTN_GHOST, LP_BTN_PRIMARY, LP_EYEBROW } from '../components/lp/styles';
import type { PolicyFieldIssue } from '../components/lp/types';
import { useLpPolicy } from '../hooks/useLpPolicy';
import { useLpPoolCandidates } from '../hooks/useLpPoolCandidates';
import { useAuthSession } from '../hooks/useAuthSession';
import { routes } from '../lib/routes';

/**
 * The control surface for a system that spends real money without asking.
 *
 * Three things have to be true of this page at a glance, and the layout is
 * arranged around them:
 *
 *   1. What is live right now (version, allowlist size, the two money caps) —
 *      the strip at the top, before anything editable.
 *   2. What each setting will actually cause — a plain-English readout under
 *      every group, not just a labelled number.
 *   3. What is merely *visible* versus what is *permitted* — the entire point
 *      of the allowlist picker; see `components/lp/selection.ts`.
 */

const EMPTY_ISSUES: PolicyFieldIssue[] = [];

export default function LpAutomationPage() {
  const { ready, isAuthenticated } = useAuthSession();
  const enabled = ready && isAuthenticated;

  const {
    policy,
    versions,
    status,
    loading,
    error,
    unavailable,
    saving,
    saveError,
    serverIssues,
    savedAt,
    refresh,
    save,
    clearServerIssues,
  } = useLpPolicy(enabled);

  const [draft, setDraft] = useState<PolicyDraft>(DEFAULT_POLICY_DRAFT);
  const [baseline, setBaseline] = useState<PolicyDraft>(DEFAULT_POLICY_DRAFT);
  const [clientIssues, setClientIssues] = useState<PolicyFieldIssue[]>(EMPTY_ISSUES);

  // `dirty` is derived rather than tracked: a flag that can disagree with the
  // form is exactly how a page tells someone their change is saved when it is
  // not.
  const dirty = !draftsEqual(draft, baseline);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baselineRef = useRef(baseline);

  // Adopt the server's policy as the editing baseline, but never clobber edits
  // in flight — a background refresh must not silently discard typed changes.
  useEffect(() => {
    const next = draftFromPolicy(policy);
    const untouched = draftsEqual(draftRef.current, baselineRef.current);
    baselineRef.current = next;
    setBaseline(next);
    if (untouched) setDraft(next);
  }, [policy]);

  const updateDraft = (next: PolicyDraft) => {
    setDraft(next);
    if (clientIssues.length > 0) setClientIssues(EMPTY_ISSUES);
    if (serverIssues.length > 0) clearServerIssues();
  };

  const revert = () => {
    setDraft(baseline);
    setClientIssues(EMPTY_ISSUES);
    clearServerIssues();
  };

  const loadDefaults = () => {
    const next: PolicyDraft = { ...DEFAULT_POLICY_DRAFT, allowedPools: draft.allowedPools };
    updateDraft(next);
  };

  // Discovery is driven by the *draft* criteria so an edit shows its effect on
  // the shortlist before it is saved. Fall back to the shipped defaults while a
  // field is mid-edit, rather than querying with NaN.
  const minTvlUsd = useMemo(() => {
    const value = toNumber(draft.poolSelectionCriteria.minTvlUsd);
    return Number.isFinite(value) ? value : 250_000;
  }, [draft.poolSelectionCriteria.minTvlUsd]);

  const min24hVolumeUsd = useMemo(() => {
    const value = toNumber(draft.poolSelectionCriteria.min24hVolumeUsd);
    return Number.isFinite(value) ? value : 50_000;
  }, [draft.poolSelectionCriteria.min24hVolumeUsd]);

  const pools = useLpPoolCandidates(minTvlUsd, min24hVolumeUsd, enabled);

  const savedAllowlist = useMemo(() => baseline.allowedPools, [baseline]);

  const summary = useMemo(
    () => summarizeAllowlist(pools.candidates, draft.allowedPools, savedAllowlist),
    [pools.candidates, draft.allowedPools, savedAllowlist],
  );

  // The server's field errors win over the local mirror: the local copy exists
  // for speed, the server's answer is the one that decided.
  const fieldErrors = useMemo(
    () => ({ ...issuesByField(clientIssues), ...issuesByField(serverIssues) }),
    [clientIssues, serverIssues],
  );

  const handleSave = async () => {
    const issues = validatePolicyDraft(draft);
    if (issues.length > 0) {
      setClientIssues(issues);
      return;
    }
    setClientIssues(EMPTY_ISSUES);
    const result = await save(draftToPayload(draft));
    if (result.ok && result.policy) {
      // Re-seed both sides from what the server actually stored, so "unsaved"
      // reflects the persisted row rather than the text that was typed.
      const stored = draftFromPolicy(result.policy);
      baselineRef.current = stored;
      setBaseline(stored);
      setDraft(stored);
    }
  };

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-full bg-oct-bg">
        <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <ConsoleEmptyState
        icon={ShieldCheck}
        eyebrow="[ LP AUTOMATION ]"
        title="Sign in to manage the LP policy"
        description="The automation policy decides how much capital the LP manager may deploy and which pools it may touch. It is scoped to your account."
        actionLabel="SIGN IN"
        actionTo={routes.login}
        secondaryLabel="← Back to console home"
        secondaryTo={routes.home}
      />
    );
  }

  const savedAllowlistSize = status?.allowlistSize ?? savedAllowlist.length;
  const activeVersion = status?.activeVersion ?? policy?.version ?? null;
  const hasPolicy = status?.hasPolicy ?? policy !== null;
  const totalIssues = clientIssues.length + serverIssues.length;
  const nextVersion = Math.max(versions[0] ?? 0, activeVersion ?? 0) + 1;

  return (
    <div className="h-full min-h-0 flex flex-col bg-oct-bg overflow-hidden">
      <div className="shrink-0 px-4 sm:px-6 py-4 border-b-2 border-oct-accent bg-oct-panel">
        <div className="flex flex-wrap items-end gap-4 justify-between">
          <div className="min-w-0">
            <p className={`${LP_EYEBROW} text-oct-accent mb-1`}>[ LP AUTOMATION ]</p>
            <h1 className="font-display text-2xl sm:text-3xl text-oct-text tracking-tight">Automation Policy</h1>
            <p className="font-mono text-[11px] text-oct-muted mt-1 max-w-2xl leading-relaxed">
              The signer process only ever reads this policy — it accepts no writes and has no inbound network surface.
              Everything the automation is permitted to do is decided here.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={loadDefaults} className={LP_BTN_GHOST} title="Load the shipped conservative defaults">
              <Beaker size={12} />
              Defaults
            </button>
            <button type="button" onClick={() => void refresh()} className={LP_BTN_GHOST} title="Reload the saved policy">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Reload
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-5 space-y-4">
        {unavailable && (
          <div className="border-2 border-oct-yellow bg-oct-surface-raised px-4 py-3 font-mono text-xs text-oct-text">
            The LP automation API is not available on this backend yet. The editor below is showing local defaults and
            cannot save.
          </div>
        )}

        {error && !unavailable && (
          <div className="border-2 border-oct-flame bg-oct-surface-raised px-4 py-3 font-mono text-xs text-oct-text flex items-center justify-between gap-3">
            <span>Could not load the saved policy: {error}</span>
            <button type="button" onClick={() => void refresh()} className="text-oct-accent underline hover:no-underline">
              Retry
            </button>
          </div>
        )}

        <LpSafetyStrip
          activeVersion={activeVersion}
          hasPolicy={hasPolicy}
          allowlistSize={savedAllowlistSize}
          surfacedCount={summary.surfacedCount}
          maxPositionSizeUsd={toNumber(baseline.maxPositionSizeUsd)}
          dailySpendCapUsd={toNumber(baseline.dailySpendCapUsd)}
        />

        {savedAllowlistSize === 0 && (
          <LpIdleNotice surfacedCount={summary.surfacedCount} pendingAdds={summary.pendingAdds} />
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-4 items-start">
          <div className="space-y-4 order-2 xl:order-1">
            <LpPolicyEditor draft={draft} onChange={updateDraft} errors={fieldErrors} disabled={unavailable} />
          </div>

          <div className="space-y-4 order-1 xl:order-2">
            <LpPoolPicker
              candidates={pools.candidates}
              loading={pools.loading}
              error={pools.error}
              unavailable={pools.unavailable}
              skippedCount={pools.skippedCount}
              chain={draft.chain}
              minTvlUsd={minTvlUsd}
              min24hVolumeUsd={min24hVolumeUsd}
              draftAllowlist={draft.allowedPools}
              savedAllowlist={savedAllowlist}
              onChangeAllowlist={(next) => updateDraft({ ...draft, allowedPools: next })}
              onRefresh={() => void pools.refresh()}
              disabled={unavailable}
            />
            <LpVersionHistory versions={versions} activeVersion={activeVersion} loading={loading} />
          </div>
        </div>
      </div>

      <div
        className={`shrink-0 border-t-2 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3 transition-colors ${
          dirty ? 'border-oct-accent bg-oct-accent-dim' : 'border-oct-border bg-oct-surface'
        }`}
      >
        <div className="min-w-0 flex items-center gap-3 flex-wrap">
          {totalIssues > 0 ? (
            <span className="font-mono text-[11px] text-oct-flame inline-flex items-center gap-1.5">
              <AlertTriangle size={12} />
              {totalIssues} field{totalIssues === 1 ? ' needs' : 's need'} attention
              {serverIssues.length > 0 && <span className="text-oct-muted">(rejected by the server)</span>}
            </span>
          ) : dirty ? (
            <span className="font-mono text-[11px] text-oct-text">
              Unsaved changes — the signer still reads v{activeVersion ?? '—'}.
            </span>
          ) : savedAt ? (
            <span className="font-mono text-[11px] text-oct-muted inline-flex items-center gap-1.5">
              <Check size={12} className="text-oct-green" />
              Saved. Open positions keep the version they were opened under.
            </span>
          ) : (
            <span className="font-mono text-[11px] text-oct-muted">
              Saving creates a new version; it never changes a position already open.
            </span>
          )}
          {saveError && totalIssues === 0 && (
            <span className="font-mono text-[11px] text-oct-flame truncate" title={saveError}>
              {saveError}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={revert} disabled={!dirty || saving} className={LP_BTN_GHOST}>
            <RotateCcw size={12} />
            Revert
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || saving || unavailable}
            className={LP_BTN_PRIMARY}
          >
            <Save size={12} className={saving ? 'animate-pulse' : ''} />
            {saving ? 'Saving…' : `Save as v${nextVersion}`}
          </button>
        </div>
      </div>
    </div>
  );
}
