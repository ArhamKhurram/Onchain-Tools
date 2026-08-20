import { useEffect, useRef, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import type { RadarMultipleEmojiRule } from '@oct/shared';
import {
  RADAR_COLUMN_LABELS,
  RADAR_COLUMN_ORDER,
  DEFAULT_VISIBLE_COLUMNS,
  saveVisibleRadarColumns,
  type RadarColumnId,
} from './radarColumns';
import RadarEmojiRules from './RadarEmojiRules';

export type MentionWindow = '15m' | '1h' | '4h';

interface RadarSettingsProps {
  mentionWindow: MentionWindow;
  onMentionWindowChange: (w: MentionWindow) => void;
  visibleColumns: Set<RadarColumnId>;
  onVisibleColumnsChange: (cols: Set<RadarColumnId>) => void;
  /** Resolved threshold→emoji ladder for the × column. */
  emojiRules: readonly RadarMultipleEmojiRule[];
  onEmojiRulesChange: (next: RadarMultipleEmojiRule[]) => void;
}

export default function RadarSettings({
  mentionWindow,
  onMentionWindowChange,
  visibleColumns,
  onVisibleColumnsChange,
  emojiRules,
  onEmojiRulesChange,
}: RadarSettingsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggleColumn = (id: RadarColumnId) => {
    const next = new Set(visibleColumns);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onVisibleColumnsChange(next);
    saveVisibleRadarColumns(next);
  };

  const resetColumns = () => {
    const next = new Set(DEFAULT_VISIBLE_COLUMNS);
    onVisibleColumnsChange(next);
    saveVisibleRadarColumns(next);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-oct-sm text-[11px] font-mono font-bold uppercase border transition-all ${
          open
            ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
            : 'text-oct-muted border-transparent hover:text-oct-text hover:border-oct-border-bright'
        }`}
        title="Radar columns & window"
      >
        <Settings2 size={12} />
        columns
      </button>

      {open && (
        <div className="oct-card absolute left-0 top-full mt-2 z-50 w-72 max-h-[70vh] overflow-y-auto shadow-oct-soft-lg p-3.5">
          <div className="flex items-center justify-between mb-3">
            <span className="oct-eyebrow">
              Radar display
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-0.5 text-oct-muted hover:text-oct-text"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>

          <p className="oct-eyebrow mb-2">Mention window</p>
          <div className="flex gap-1 mb-4">
            {(['15m', '1h', '4h'] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => onMentionWindowChange(w)}
                className={`flex-1 px-2 py-1 rounded-oct-sm text-[11px] font-mono font-bold border transition-all ${
                  mentionWindow === w
                    ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                    : 'text-oct-muted border-oct-border-bright hover:text-oct-text hover:border-oct-text'
                }`}
              >
                {w}
              </button>
            ))}
          </div>

          <p className="oct-eyebrow mb-2">Columns</p>
          <ul className="space-y-1.5 max-h-48 overflow-y-auto">
            {RADAR_COLUMN_ORDER.map((id) => (
              <li key={id}>
                <label className="flex items-center gap-2 cursor-pointer font-mono text-[13px] text-oct-text">
                  <input
                    type="checkbox"
                    checked={visibleColumns.has(id)}
                    onChange={() => toggleColumn(id)}
                    className="accent-oct-accent"
                  />
                  {RADAR_COLUMN_LABELS[id]}
                </label>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={resetColumns}
            className="mt-3 w-full text-[10px] font-mono uppercase text-oct-muted hover:text-oct-accent"
          >
            Reset to defaults
          </button>

          <div className="mt-4 pt-3.5 border-t border-oct-border">
            <RadarEmojiRules rules={emojiRules} onChange={onEmojiRulesChange} />
          </div>
        </div>
      )}
    </div>
  );
}
