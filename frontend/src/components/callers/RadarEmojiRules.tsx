import { useEffect, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  DEFAULT_RADAR_MULTIPLE_EMOJI_RULES,
  MAX_RADAR_EMOJI_RULES,
  MAX_RADAR_EMOJI_LENGTH,
  sanitizeRadarEmoji,
  sanitizeRadarEmojiRules,
  type RadarMultipleEmojiRule,
} from '@oct/shared';

/**
 * The threshold→emoji ladder editor, shown inside RadarSettings.
 *
 * Kept out of both RadarTable and RadarSettings because RadarTable was already
 * large and this is self-contained: a draft list, a
 * sanitiser on the way out, and one `onChange` per committed edit.
 *
 * Edits commit on blur (and immediately on add / remove / reset) rather than
 * per keystroke, so typing "12" into a threshold is one save, not two.
 */

interface DraftRule {
  /** Stable across re-sorts so an input doesn't lose focus mid-edit. */
  id: number;
  threshold: string;
  emoji: string;
}

let nextDraftId = 1;

function toDraft(rules: readonly RadarMultipleEmojiRule[]): DraftRule[] {
  return rules.map((r) => ({ id: nextDraftId++, threshold: String(r.threshold), emoji: r.emoji }));
}

function fromDraft(draft: DraftRule[]): RadarMultipleEmojiRule[] {
  return sanitizeRadarEmojiRules(
    draft.map((d) => ({ threshold: Number(d.threshold), emoji: d.emoji })),
  );
}

/** Two rule lists are equal if the sanitised ladder is the same, so a no-op
 *  blur (tabbing through without changing anything) never fires a save. */
function sameRules(a: RadarMultipleEmojiRule[], b: readonly RadarMultipleEmojiRule[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.threshold === b[i].threshold && r.emoji === b[i].emoji);
}

export default function RadarEmojiRules({
  rules,
  onChange,
}: {
  rules: readonly RadarMultipleEmojiRule[];
  onChange: (next: RadarMultipleEmojiRule[]) => void;
}) {
  const [draft, setDraft] = useState<DraftRule[]>(() => toDraft(rules));

  // Re-sync when the persisted rules change underneath us (a save landing, a
  // reset, another tab). Skipped while the draft already matches so an in-flight
  // edit isn't clobbered by the round-trip of its own save.
  useEffect(() => {
    setDraft((current) => (sameRules(fromDraft(current), rules) ? current : toDraft(rules)));
  }, [rules]);

  const commit = (next: DraftRule[]) => {
    const sanitized = fromDraft(next);
    if (!sameRules(sanitized, rules)) onChange(sanitized);
  };

  const patch = (id: number, field: 'threshold' | 'emoji', value: string) => {
    setDraft((d) => d.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const remove = (id: number) => {
    const next = draft.filter((r) => r.id !== id);
    setDraft(next);
    commit(next);
  };

  // A new row starts above the current top rung (a new tier, not a duplicate)
  // and with a blank emoji, so it stays a draft until the user gives it a glyph
  // — the sanitiser drops emoji-less rules, so nothing is persisted yet.
  const add = () => {
    if (draft.length >= MAX_RADAR_EMOJI_RULES) return;
    const top = draft.reduce((max, r) => Math.max(max, Number(r.threshold) || 0), 0);
    setDraft([
      ...draft,
      { id: nextDraftId++, threshold: String(Math.max(2, Math.round(top) + 2)), emoji: '' },
    ]);
  };

  const reset = () => {
    const defaults = DEFAULT_RADAR_MULTIPLE_EMOJI_RULES.map((r) => ({ ...r }));
    setDraft(toDraft(defaults));
    if (!sameRules(defaults, rules)) onChange(defaults);
  };

  const sorted = [...draft].sort((a, b) => (Number(a.threshold) || 0) - (Number(b.threshold) || 0));

  return (
    <div>
      <p className="oct-eyebrow mb-1.5">Multiple markers</p>
      <p className="text-[11px] leading-snug text-oct-muted mb-2">
        A marker beside the × once a token reaches that multiple.{' '}
        <span className="text-oct-text">Only the highest rule that matches shows</span> — at 6x
        with the defaults you get 🔥, not 🧊🔥. Paste any emoji. The × is live market cap
        against market cap at the first call, so a marker means the price moved, not that
        anyone booked it.
      </p>

      {sorted.length === 0 ? (
        <p className="text-[11px] text-oct-muted italic mb-2">
          No markers — the × column shows the number only.
        </p>
      ) : (
        <ul className="space-y-1 mb-2">
          {sorted.map((r) => (
            <li key={r.id} className="flex items-center gap-1.5">
              <input
                type="number"
                min={1.1}
                step={0.5}
                value={r.threshold}
                onChange={(e) => patch(r.id, 'threshold', e.target.value)}
                onBlur={() => commit(draft)}
                aria-label="Multiple threshold"
                className="w-16 px-1.5 py-1 rounded-oct-sm border border-oct-border bg-oct-surface font-mono text-[12px] text-oct-text tabular-nums"
              />
              <span className="font-mono text-[11px] text-oct-muted">x and up</span>
              <input
                type="text"
                value={r.emoji}
                maxLength={MAX_RADAR_EMOJI_LENGTH}
                onChange={(e) => patch(r.id, 'emoji', sanitizeRadarEmoji(e.target.value))}
                onBlur={() => commit(draft)}
                placeholder="🔥"
                aria-label="Marker emoji"
                className="w-10 ml-auto px-1.5 py-1 rounded-oct-sm border border-oct-border bg-oct-surface text-[13px] text-center text-oct-text"
              />
              <button
                type="button"
                onClick={() => remove(r.id)}
                className="p-1 text-oct-muted hover:text-oct-flame shrink-0"
                aria-label={`Remove the ${r.threshold}x marker`}
                title="Remove this marker"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={add}
          disabled={draft.length >= MAX_RADAR_EMOJI_RULES}
          className="flex items-center gap-1 px-2 py-1 rounded-oct-sm border border-oct-border-bright text-[10px] font-mono uppercase text-oct-muted hover:text-oct-text hover:border-oct-text disabled:opacity-40 disabled:hover:text-oct-muted"
        >
          <Plus size={11} />
          add marker
        </button>
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-1 ml-auto text-[10px] font-mono uppercase text-oct-muted hover:text-oct-accent"
          title="Back to 3x 🧊 / 5x 🔥"
        >
          <RotateCcw size={11} />
          defaults
        </button>
      </div>
    </div>
  );
}
