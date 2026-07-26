import { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { LP_HELP } from './styles';

interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface LpSegmentedFieldProps<T extends string> {
  label: string;
  /** Dotted policy path — also the key errors are looked up under. */
  field: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
  /** What this choice means in practice, not what it is named. */
  help: string;
  error?: string;
  /** Rendered dimmed next to the label, e.g. "default narrow". */
  defaultHint?: string;
  disabled?: boolean;
}

/**
 * A three-ish-way choice from a closed enum, styled in the same tokens as
 * `LpNumberField`. A raw `<select>` hides the alternatives behind a click; on a
 * page whose whole job is to make a setting's consequence legible, the options
 * are laid out side by side with the active one filled in the accent so it reads
 * at a glance.
 */
export default function LpSegmentedField<T extends string>({
  label,
  field,
  value,
  onChange,
  options,
  help,
  error,
  defaultHint,
  disabled = false,
}: LpSegmentedFieldProps<T>) {
  const id = useId();

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-oct-text font-semibold">
          {label}
        </span>
        {defaultHint && (
          <span className="font-mono text-[10px] text-oct-muted shrink-0">{defaultHint}</span>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        className="flex"
      >
        {options.map((option, index) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              data-value={option.value}
              name={field}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={[
                'flex-1 font-mono text-[11px] uppercase tracking-[0.1em] border-2 px-3 py-2 text-center',
                'transition-colors outline-none disabled:opacity-40 disabled:cursor-not-allowed',
                'focus-visible:ring-2 focus-visible:ring-oct-accent/40',
                // Collapse the shared edge so the row reads as one control, not
                // three buttons, and lift the active segment above its neighbours.
                index > 0 ? '-ml-0.5' : '',
                active
                  ? 'relative z-10 border-oct-accent bg-oct-accent text-white'
                  : 'border-oct-border bg-oct-bg text-oct-muted hover:text-oct-text hover:border-oct-border-bright',
              ].join(' ')}
            >
              {option.label}
            </button>
          );
        })}
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
