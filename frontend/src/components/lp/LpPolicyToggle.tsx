import { LP_BTN } from './styles';

interface LpPolicyToggleProps {
  label: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
  /** Shown when the draft differs from the saved policy. */
  unsaved?: boolean;
  help?: string;
}

/**
 * A two-state switch for policy booleans. Writes into the shared policy draft —
 * nothing takes effect until Save.
 */
export default function LpPolicyToggle({
  label,
  enabled,
  onChange,
  disabled = false,
  unsaved = false,
  help,
}: LpPolicyToggleProps) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(!enabled)}
          aria-pressed={enabled}
          className={`${LP_BTN} ${
            enabled
              ? 'border-oct-accent bg-oct-accent text-white hover:bg-oct-accent-hover hover:border-oct-accent-hover'
              : 'border-oct-border-bright text-oct-muted hover:text-oct-text hover:border-oct-text'
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {label}: {enabled ? 'On' : 'Off'}
        </button>
        {unsaved && (
          <span className="font-mono text-[10px] text-oct-yellow uppercase tracking-[0.1em]">Unsaved</span>
        )}
      </div>
      {help && <p className="font-mono text-[10px] text-oct-muted leading-relaxed">{help}</p>}
    </div>
  );
}
