import { useMemo, useState } from 'react';
import { ClipboardList, X } from 'lucide-react';
import { parseUserIdentifiers, summarizeParse, type ParsedIdentifiers } from '../utils/userIdentifiers';

/**
 * Paste-many entry for the user-identifier lists (room highlights, room filter,
 * global highlights). It only ever hands the caller a list of new values —
 * persistence stays on whatever path the single-add button already uses.
 *
 * Two skins: `cockpit` for the room-config modal (brutalist, 2px borders) and
 * `settings` for the settings pages (soft, 1px borders).
 */

interface BulkAddUsersProps {
  /** The list being added to — used to report which pasted entries are already tracked. */
  existing: readonly string[];
  /** Receives only the new, valid, deduped entries, in paste order. */
  onAdd: (values: string[]) => void;
  variant?: 'cockpit' | 'settings';
  /** Noun used in the copy, e.g. "highlighted users". */
  noun?: string;
}

const PLACEHOLDER = `Paste one per line (commas work too):

297153970613387264
@degen_alerts
<@155149108183695360>`;

export default function BulkAddUsers({
  existing,
  onAdd,
  variant = 'cockpit',
  noun = 'users',
}: BulkAddUsersProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [lastResult, setLastResult] = useState<ParsedIdentifiers | null>(null);

  const preview = useMemo(() => parseUserIdentifiers(text, existing), [text, existing]);

  const cockpit = variant === 'cockpit';
  const panelClass = cockpit
    ? 'rounded-cockpit border-2 border-oct-border bg-oct-bg'
    : 'rounded-oct border border-oct-border bg-oct-surface-raised';
  const textareaClass = cockpit
    ? 'w-full px-3 py-2 rounded-cockpit bg-oct-surface border-2 border-oct-border text-sm font-mono text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent resize-y'
    : 'w-full oct-input px-3 py-2 text-sm font-mono resize-y';
  const primaryClass = cockpit ? 'brutal-btn px-3 py-2 text-sm' : 'oct-btn-primary px-3 py-2 text-sm';
  const ghostClass = cockpit
    ? 'brutal-btn-ghost px-3 py-2 text-sm'
    : 'px-3 py-2 text-sm rounded-oct border border-oct-border text-oct-muted hover:text-oct-text';

  const handleAdd = () => {
    if (preview.added.length > 0) onAdd(preview.added);
    setLastResult(preview);
    setText('');
  };

  if (!open) {
    return (
      <div className="mb-4">
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-oct-muted hover:text-oct-accent transition-colors duration-100"
        >
          <ClipboardList size={13} />
          Bulk add
        </button>
        {lastResult && <ResultBanner result={lastResult} cockpit={cockpit} />}
      </div>
    );
  }

  return (
    <div className={`mb-4 p-3 ${panelClass}`}>
      <div className="flex items-center justify-between mb-2">
        <label
          htmlFor="bulk-add-users"
          className="font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-oct-muted"
        >
          Bulk add {noun}
        </label>
        <button
          onClick={() => { setOpen(false); setText(''); }}
          className="text-oct-muted hover:text-oct-text"
          aria-label="Close bulk add"
        >
          <X size={14} />
        </button>
      </div>

      <textarea
        id="bulk-add-users"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder={PLACEHOLDER}
        className={textareaClass}
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
        <p className="text-xs text-oct-muted" data-testid="bulk-add-preview">
          {text.trim() === ''
            ? 'Discord IDs, @telegram_handles or usernames. Split on newlines and commas.'
            : `${preview.added.length} to add` +
              (preview.duplicates.length > 0 ? ` · ${preview.duplicates.length} already tracked` : '') +
              (preview.invalid.length > 0 ? ` · ${preview.invalid.length} unrecognized` : '')}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => { setOpen(false); setText(''); }} className={ghostClass}>
            Cancel
          </button>
          <button onClick={handleAdd} disabled={preview.added.length === 0} className={primaryClass}>
            Add {preview.added.length || ''}
          </button>
        </div>
      </div>

      {lastResult && <ResultBanner result={lastResult} cockpit={cockpit} />}
    </div>
  );
}

function ResultBanner({ result, cockpit }: { result: ParsedIdentifiers; cockpit: boolean }) {
  return (
    <div
      data-testid="bulk-add-result"
      className={`mt-2 px-3 py-2 text-xs ${
        cockpit
          ? 'rounded-cockpit border-2 border-oct-border bg-oct-surface'
          : 'rounded-oct border border-oct-border bg-oct-surface'
      }`}
    >
      <p className="text-oct-text font-mono">{summarizeParse(result)}</p>
      {result.invalid.length > 0 && (
        <>
          <p className="text-oct-yellow mt-1.5">
            Couldn&apos;t read these as a user ID or handle — fix and paste again:
          </p>
          <div className="flex flex-wrap gap-1 mt-1">
            {result.invalid.slice(0, 20).map((entry, i) => (
              <span
                key={`${entry}-${i}`}
                className="px-1.5 py-0.5 rounded bg-oct-bg border border-oct-border font-mono text-[11px] text-oct-muted break-all"
              >
                {entry}
              </span>
            ))}
            {result.invalid.length > 20 && (
              <span className="text-[11px] text-oct-muted">+{result.invalid.length - 20} more</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
