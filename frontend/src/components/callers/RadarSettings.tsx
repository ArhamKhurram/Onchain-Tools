import { useEffect, useRef, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import type { RadarMultipleEmojiRule } from '@oct/shared';
import { cn } from '../../lib/utils';
import { m, AnimatePresence, MotionFeatures, slideInRight, useTransition } from '../../lib/motion';
import {
  RADAR_COLUMN_LABELS,
  RADAR_COLUMN_ORDER,
  DEFAULT_VISIBLE_COLUMNS,
  saveVisibleRadarColumns,
  type RadarColumnId,
} from './radarColumns';
import RadarEmojiRules from './RadarEmojiRules';
import {
  RADAR_PILL_CLASS,
  RADAR_PILL_OFF_CLASS,
  RADAR_PILL_ON_CLASS,
  RADAR_PILL_OUTLINE_CLASS,
} from './radarPills';

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

/**
 * The Radar's display settings popover: mention window, column set and the
 * × emoji ladder. This is chrome, not stream — it is the one animated surface
 * on the Radar, and `MotionFeatures` is mounted here rather than higher so
 * the motion runtime rides in with the settings panel and never touches the
 * row render path.
 */
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
  const drawer = useTransition('drawer');

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
        className={cn(
          RADAR_PILL_CLASS,
          'flex items-center gap-snug',
          open ? RADAR_PILL_ON_CLASS : RADAR_PILL_OFF_CLASS,
        )}
        title="Radar columns & window"
      >
        <Settings2 size={12} />
        columns
      </button>

      <MotionFeatures>
        <AnimatePresence>
          {open && (
            <m.div
              variants={slideInRight}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={drawer}
              className="oct-card absolute left-0 top-full mt-cozy z-50 w-72 max-h-[70vh] overflow-y-auto shadow-oct-soft-lg p-comfy"
            >
              <div className="flex items-center justify-between mb-comfy">
                <span className="type-title text-oct-text">Radar display</span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-hair text-oct-muted hover:text-oct-text"
                  aria-label="Close"
                >
                  <X size={14} />
                </button>
              </div>

              <p className="oct-eyebrow mb-cozy">Mention window</p>
              <div className="flex gap-tight mb-roomy">
                {(['15m', '1h', '4h'] as const).map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => onMentionWindowChange(w)}
                    className={cn(
                      RADAR_PILL_CLASS,
                      'flex-1 normal-case',
                      mentionWindow === w ? RADAR_PILL_ON_CLASS : RADAR_PILL_OUTLINE_CLASS,
                    )}
                  >
                    {w}
                  </button>
                ))}
              </div>

              <p className="oct-eyebrow mb-cozy">Columns</p>
              <ul className="space-y-tight max-h-48 overflow-y-auto">
                {RADAR_COLUMN_ORDER.map((id) => (
                  <li key={id}>
                    <label className="flex items-center gap-cozy cursor-pointer font-mono type-label font-normal text-oct-text">
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
                className="mt-comfy w-full font-mono text-2xs uppercase text-oct-muted hover:text-oct-accent"
              >
                Reset to defaults
              </button>

              <div className="mt-roomy pt-comfy border-t border-oct-border">
                <RadarEmojiRules rules={emojiRules} onChange={onEmojiRulesChange} />
              </div>
            </m.div>
          )}
        </AnimatePresence>
      </MotionFeatures>
    </div>
  );
}
