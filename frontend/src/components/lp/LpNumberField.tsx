import { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { LP_HELP, LP_INPUT } from './styles';

interface LpNumberFieldProps {
  label: string;
  /** Dotted policy path — also the key errors are looked up under. */
  field: string;
  value: string;
  onChange: (value: string) => void;
  /** What this setting means in practice, not what it is named. */
  help: string;
  /** Unit shown inside the field: `$` leads, everything else trails. */
  unit?: string;
  /** Money fields get the accent rail; configuration fields do not. */
  money?: boolean;
  error?: string;
  /** Rendered dimmed next to the label, e.g. "default 250". */
  defaultHint?: string;
  disabled?: boolean;
}

export default function LpNumberField({
  label,
  field,
  value,
  onChange,
  help,
  unit,
  money = false,
  error,
  defaultHint,
  disabled = false,
}: LpNumberFieldProps) {
  const id = useId();
  const leading = money ? '$' : null;
  const trailing = !money && unit ? unit : null;

  return (
    <div className={money ? 'border-l-2 border-oct-accent pl-3' : ''}>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <label
          htmlFor={id}
          className="font-mono text-[11px] uppercase tracking-[0.1em] text-oct-text font-semibold"
        >
          {label}
        </label>
        {defaultHint && (
          <span className="font-mono text-[10px] text-oct-muted shrink-0">{defaultHint}</span>
        )}
      </div>

      <div className="relative">
        {leading && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-sm text-oct-accent pointer-events-none">
            {leading}
          </span>
        )}
        <input
          id={id}
          name={field}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help`}
          className={[
            LP_INPUT,
            leading ? 'pl-6' : '',
            trailing ? 'pr-14' : '',
            // Money-ness is carried by the accent rail and the `$` glyph, not by
            // a red box — the red border is reserved for an actual error.
            error ? 'border-oct-flame' : money ? 'border-oct-border-bright' : 'border-oct-border',
          ].join(' ')}
        />
        {trailing && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase tracking-wider text-oct-muted pointer-events-none">
            {trailing}
          </span>
        )}
      </div>

      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 font-mono text-[11px] text-oct-flame leading-snug">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </p>
      )}

      <p id={`${id}-help`} className={`${LP_HELP} mt-1.5`}>
        {help}
      </p>
    </div>
  );
}
