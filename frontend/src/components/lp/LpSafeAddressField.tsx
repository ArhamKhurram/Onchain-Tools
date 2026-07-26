import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, Save, Wallet } from 'lucide-react';
import { LP_BTN_PRIMARY, LP_INPUT } from './styles';
import { issuesByField } from './policyDraft';
import { normalizeSafeAddress, safeAddressDirty, validateSafeAddress, type LpSettings } from './positions';
import { shortAddress } from './format';
import type { PolicyFieldIssue } from './types';

/**
 * Which Safe the positions view reads.
 *
 * Compact on purpose. This is a one-time setup field, not a control that moves
 * money — it decides what is *looked at*, never what is permitted. The policy
 * editor keeps the accent rail and the display face; this one stays mono, so the
 * two are not mistaken for the same class of setting.
 */

export interface LpSafeAddressFieldProps {
  settings: LpSettings | null;
  loading: boolean;
  saving: boolean;
  saveError: string | null;
  /** Field errors from the server's 400. Authoritative over the local check. */
  issues: PolicyFieldIssue[];
  savedAt: number | null;
  disabled?: boolean;
  /** Resolves true when the server accepted the address. */
  onSave: (address: string) => Promise<boolean>;
  onEdit: () => void;
}

export default function LpSafeAddressField({
  settings,
  loading,
  saving,
  saveError,
  issues,
  savedAt,
  disabled = false,
  onSave,
  onEdit,
}: LpSafeAddressFieldProps) {
  const id = useId();
  const saved = settings?.safeAddress ?? null;
  const [value, setValue] = useState(saved ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  // Adopt the server's value without clobbering a half-typed address: a refresh
  // landing mid-edit must not replace what the operator is in the middle of.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    setValue(saved ?? '');
  }, [saved]);

  const serverError = issuesByField(issues).safeAddress ?? null;
  const error = serverError ?? localError;
  const dirty = safeAddressDirty(value, saved);

  const handleChange = (next: string) => {
    touched.current = true;
    setValue(next);
    if (localError) setLocalError(null);
    if (issues.length > 0 || saveError) onEdit();
  };

  const submit = async () => {
    const message = validateSafeAddress(value);
    if (message) {
      setLocalError(message);
      return;
    }
    setLocalError(null);
    const ok = await onSave(normalizeSafeAddress(value));
    if (ok) touched.current = false;
  };

  return (
    <div className="px-4 py-3 border-b-2 border-oct-border bg-oct-surface-raised">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <label
          htmlFor={id}
          className="font-mono text-[11px] uppercase tracking-[0.1em] text-oct-text font-semibold inline-flex items-center gap-1.5"
        >
          <Wallet size={12} strokeWidth={2} className="text-oct-muted" />
          Safe address
        </label>
        {saved && !dirty && !error && (
          <span className="font-mono text-[10px] text-oct-muted inline-flex items-center gap-1 shrink-0">
            <Check size={10} strokeWidth={3} className="text-oct-green" />
            {savedAt ? 'Saved' : 'Reading'} {shortAddress(saved)}
          </span>
        )}
        {dirty && !error && (
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-oct-yellow shrink-0">
            Unsaved
          </span>
        )}
      </div>

      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          id={id}
          name="safeAddress"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="0x…"
          disabled={disabled || loading}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help`}
          className={`${LP_INPUT} flex-1 min-w-[18rem] ${error ? 'border-oct-flame' : 'border-oct-border'}`}
        />
        <button type="submit" disabled={disabled || saving || !dirty} className={LP_BTN_PRIMARY}>
          <Save size={12} className={saving ? 'animate-pulse' : ''} />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </form>

      {error && (
        <p className="mt-2 flex items-start gap-1.5 font-mono text-[11px] text-oct-flame leading-snug">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}
      {!error && saveError && (
        <p className="mt-2 font-mono text-[11px] text-oct-flame leading-snug">{saveError}</p>
      )}

      <p id={`${id}-help`} className="font-mono text-[11px] text-oct-muted leading-relaxed mt-2">
        The Safe whose LP positions are listed below. Saving it only changes what this page reads — it grants
        the automation nothing and does not touch the policy.
        {settings?.moduleAddress && (
          <>
            {' '}Module <span className="text-oct-text">{shortAddress(settings.moduleAddress)}</span> is the
            on-chain limit; the policy above is the off-chain one.
          </>
        )}
      </p>
    </div>
  );
}
