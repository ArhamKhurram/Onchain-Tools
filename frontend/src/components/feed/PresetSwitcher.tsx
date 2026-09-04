import { cn } from '../../lib/utils';
import { FEED_CHROME_PRESETS, FEED_CHROME_PRESET_LABEL } from './feedChromeContract';
import type { FeedChromePreset } from './feedChromeContract';

interface PresetSwitcherProps {
  value: FeedChromePreset;
  onChange: (preset: FeedChromePreset) => void;
  /**
   * `surface` sits on the chrome's normal surface (terminal, masthead);
   * `accent` sits on the rail's solid accent footer, where border/muted tokens
   * would vanish, so it draws with black-alpha instead.
   */
  tone?: 'surface' | 'accent';
  className?: string;
}

/**
 * The in-feed preset control. Each preset's layout decides where it sits;
 * this only draws the segmented control and reports the pick. The write goes
 * through the model's `setPreset`, i.e. the same config path Settings uses.
 */
export default function PresetSwitcher({ value, onChange, tone = 'surface', className }: PresetSwitcherProps) {
  const onAccent = tone === 'accent';
  return (
    <div
      role="group"
      aria-label="Feed layout"
      className={cn(
        'flex items-center rounded-cockpit border-2',
        onAccent ? 'border-black/35' : 'border-oct-border',
        className,
      )}
    >
      {FEED_CHROME_PRESETS.map((preset) => {
        const active = preset === value;
        return (
          <button
            key={preset}
            type="button"
            onClick={() => { if (!active) onChange(preset); }}
            aria-pressed={active}
            title={`${FEED_CHROME_PRESET_LABEL[preset]} layout`}
            className={cn(
              'type-caption font-mono uppercase tracking-[0.12em] leading-none px-snug py-tight transition-colors duration-fast',
              onAccent
                ? active
                  ? 'bg-black/85 text-oct-accent font-bold'
                  : 'text-black/70 hover:text-black hover:bg-black/15'
                : active
                  ? 'bg-oct-accent-dim text-oct-accent font-bold'
                  : 'text-oct-muted hover:text-oct-text hover:bg-oct-surface-raised',
            )}
          >
            {/* One glyph on narrow viewports, the word from `sm` up. */}
            <span className="sm:hidden">{FEED_CHROME_PRESET_LABEL[preset].charAt(0)}</span>
            <span className="hidden sm:inline">{FEED_CHROME_PRESET_LABEL[preset]}</span>
          </button>
        );
      })}
    </div>
  );
}
