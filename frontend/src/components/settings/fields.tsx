import type { ReactNode } from 'react';
import { isHostedMode, getAccessToken } from '../../lib/supabase';
import { cn } from '../../lib/utils';

export   const apiBase = import.meta.env.VITE_API_URL
    ? `${import.meta.env.VITE_API_URL}/api`
    : '/api';

export   const authedFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (isHostedMode) {
      const token = await getAccessToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(input, { ...init, headers });
  };

// ── Settings form primitives ──────────────────────────────────────────────────
// Every settings section is built from the same dozen shapes: a heading, a
// card, a raised field row, a label, a line of help text, a segmented picker,
// a toggle chip. Before this file they were re-typed inline ~120 times with
// slightly different padding and slightly different 10/11px sizes each time,
// so tightening the screen meant editing every section. They live here now so
// density and type roles are decided once. The rules they encode:
//
//  - Named density (`p-comfy`, `gap-snug`) instead of `p-4`/`gap-1.5`.
//  - Semantic type roles: `type-heading` for the section title, `type-title`
//    for card titles, `type-body` for copy, `type-label` for form labels,
//    `type-caption` for help, `type-data` for anything numeric or key-like.
//    Nothing renders below `text-2xs` (12px).
//  - Status colour is semantic (`oct-good` / `oct-warn` / `oct-critical`);
//    the accent is reserved for the selected/brand state.
//
// `Toggle` is the one export with an outside consumer (SniperRuleFormModal),
// so its props are frozen; everything else is settings-internal.

/** Shared text-input shell. Mono is opt-in per field (`INPUT_MONO_CLASS`). */
export const INPUT_CLASS = 'w-full px-comfy py-snug oct-input type-body disabled:opacity-60 disabled:cursor-not-allowed';
/** Keys, addresses, URLs and other machine strings read better in mono. */
export const INPUT_MONO_CLASS = cn(INPUT_CLASS, 'type-data');

/* Premium pill toggle — accent-tinted track, soft knob shadow. Shared across
   every settings section and the sniper rule form. The "on" track is
   `oct-good` rather than a hue token because it carries meaning (enabled). */
export   const Toggle = ({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) => (
    <label className="flex items-start gap-cozy cursor-pointer group">
      <div
        className={`w-9 h-5 rounded-full border transition-colors duration-150 relative shrink-0 mt-hair ${value ? 'bg-oct-good border-oct-good/60' : 'bg-oct-surface-raised border-oct-border group-hover:border-oct-border-bright'}`}
        onClick={() => onChange(!value)}
      >
        <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-transform duration-150 shadow-sm ${value ? 'translate-x-[18px] bg-white' : 'translate-x-0.5 bg-oct-text'}`} />
      </div>
      <span className="type-body text-oct-text leading-snug">{label}</span>
    </label>
  );

/**
 * The compact inline switch used inside dense rows (per-sound, per-channel)
 * where a labelled `Toggle` would be too wide. Keyboard-reachable, unlike the
 * bare `div` it replaces; the label is for assistive tech only.
 */
export function MiniSwitch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      className={cn(
        'w-9 h-[18px] rounded-full border transition-colors duration-100 relative shrink-0',
        value ? 'bg-oct-good border-oct-good/60' : 'bg-oct-surface-raised border-oct-border hover:border-oct-border-bright',
      )}
    >
      <span
        className={cn(
          'absolute top-[1px] w-[14px] h-[14px] rounded-full transition-transform duration-100 shadow-sm',
          value ? 'translate-x-[19px] bg-white' : 'translate-x-[1px] bg-oct-text',
        )}
      />
    </button>
  );
}

/** Section title + optional blurb. One per section, above the cards. */
export function SectionHeader({ title, blurb, children }: { title: ReactNode; blurb?: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-tight">
      <h3 className="type-heading font-display tracking-tight text-oct-text">{title}</h3>
      {blurb && <p className="type-body text-oct-muted">{blurb}</p>}
      {children}
    </div>
  );
}

/** Vertical stack of cards under a section header. */
export function SectionStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('space-y-comfy', className)}>{children}</div>;
}

/**
 * A settings card. `title` renders as `type-title`; `blurb` is body copy below
 * it. Cards used to open with an 11px mono kicker in square brackets — the
 * kicker survives as `Kicker` for column headers, but a card title is a title.
 */
export function SettingsCard({
  title,
  blurb,
  icon,
  className,
  children,
}: {
  title?: ReactNode;
  blurb?: ReactNode;
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn('oct-card p-comfy sm:p-roomy', className)}>
      {(title || blurb) && (
        <div className={cn('flex items-start gap-cozy', children ? 'mb-comfy' : undefined)}>
          {icon && <span className="shrink-0 mt-hair text-oct-accent">{icon}</span>}
          <div className="min-w-0 space-y-tight">
            {title && <h4 className="type-title text-oct-text">{title}</h4>}
            {blurb && <p className="type-body text-oct-muted">{blurb}</p>}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

/** Raised inner row/panel inside a card: bordered, surface-raised. */
export function FieldRow({ className, children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <div title={title} className={cn('rounded-oct border border-oct-border bg-oct-surface-raised px-comfy py-cozy', className)}>
      {children}
    </div>
  );
}

/** Form label. Wrap an input to get the click-to-focus association for free. */
export function FieldLabel({ className, children, htmlFor }: { className?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('block type-label text-oct-muted mb-snug', className)}>
      {children}
    </label>
  );
}

/** A labelled field inside a `FieldRow`, the most common settings shape. */
export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <FieldRow className={className}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </FieldRow>
  );
}

/** Mono uppercase kicker for column headers and group labels (12px floor). */
export function Kicker({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn('type-caption font-mono uppercase tracking-wider text-oct-muted', className)}>{children}</p>
  );
}

/** Help / annotation copy under a control. */
export function Help({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('type-caption text-oct-muted', className)}>{children}</p>;
}

/**
 * A status line or block in a semantic colour. `critical` for errors, `warn`
 * for caveats, `good` for success — never the accent, which in the dark theme
 * is itself a red and would make a failure indistinguishable from a link.
 */
export type StatusTone = 'good' | 'warn' | 'critical';

const STATUS_TEXT: Record<StatusTone, string> = {
  good: 'text-oct-good',
  warn: 'text-oct-warn',
  critical: 'text-oct-critical',
};

const STATUS_BOX: Record<StatusTone, string> = {
  good: 'bg-oct-good-dim border-oct-good/50 text-oct-good',
  warn: 'bg-oct-warn-dim border-oct-warn/50 text-oct-warn',
  critical: 'bg-oct-critical-dim border-oct-critical/50 text-oct-critical',
};

export function StatusText({ tone, className, children, title }: { tone: StatusTone; className?: string; children: ReactNode; title?: string }) {
  return <p title={title} className={cn('type-caption', STATUS_TEXT[tone], className)}>{children}</p>;
}

export function StatusBox({ tone, className, children }: { tone: StatusTone; className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-oct border px-comfy py-cozy type-caption', STATUS_BOX[tone], className)}>
      {children}
    </div>
  );
}

/** Empty-state line inside a list slot. */
export function EmptyNote({ className, children, dashed }: { className?: string; children: ReactNode; dashed?: boolean }) {
  return (
    <p
      className={cn(
        'type-body text-oct-muted text-center py-comfy rounded-oct border bg-oct-surface-raised/40',
        dashed ? 'border-dashed border-oct-border' : 'border-oct-border',
        className,
      )}
    >
      {children}
    </p>
  );
}

// ── Choice controls ───────────────────────────────────────────────────────────

const CHIP_BASE = 'rounded-oct-sm border transition-colors duration-100 whitespace-nowrap';
const CHIP_ON = 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent';
const CHIP_OFF = 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright';

/**
 * One selectable chip. `size="sm"` is the dense variant for long lists
 * (channels, users); the default is for a handful of named options.
 */
export function Chip({
  active,
  onClick,
  children,
  size = 'md',
  className,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        CHIP_BASE,
        size === 'md' ? 'px-comfy py-snug type-label font-mono uppercase tracking-wide' : 'px-cozy py-tight type-caption font-mono',
        active ? CHIP_ON : CHIP_OFF,
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Mutually-exclusive chip group. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: ReactNode }[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap gap-snug', className)}>
      {options.map((o) => (
        <Chip key={o.value} active={value === o.value} onClick={() => onChange(o.value)} size={size}>
          {o.label}
        </Chip>
      ))}
    </div>
  );
}

/** Wrapping row of chips (multi-select filters, channel pickers). */
export function ChipRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap gap-snug', className)}>{children}</div>;
}

/** The "Clear" affordance next to a chip filter. */
export function ClearButton({ onClick, children = 'Clear' }: { onClick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-cozy py-tight type-caption font-mono uppercase tracking-wide text-oct-critical hover:text-oct-critical/70 transition-colors duration-100"
    >
      {children}
    </button>
  );
}

/** Icon-only destructive button (remove row). Turns critical on hover. */
export function RemoveButton({ onClick, title, children, className }: { onClick: () => void; title?: string; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn('text-oct-muted hover:text-oct-critical transition-colors duration-100 shrink-0', className)}
    >
      {children}
    </button>
  );
}

/** Text link to an external site; accent because it is navigation, not status. */
export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn('text-oct-accent hover:underline', className)}>
      {children}
    </a>
  );
}
