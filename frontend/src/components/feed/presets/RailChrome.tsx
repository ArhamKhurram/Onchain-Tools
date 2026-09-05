import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { m } from '../../../lib/motion';
import { routes } from '../../../lib/routes';
import { useChromeFade } from '../chromeMotion';
import PresetSwitcher from '../PresetSwitcher';
import type { FeedChromeEntry, FeedChromePresetProps } from '../feedChromeContract';

const RAIL_WIDTH = 64;
const STATUS_HEIGHT = 32;

function tileGlyph(entry: FeedChromeEntry): string {
  if (entry.kind === 'mentions') return '@';
  const compact = entry.label.replace(/[^A-Za-z0-9]/g, '');
  return (compact || entry.label).slice(0, 3).toUpperCase();
}

/** The rail sits beside the panes, but the Feed shell stacks chrome above them,
 *  so it is pinned to the shell's top-left corner instead. The shell resizes
 *  whenever the header, the banner or the window does, which is when the
 *  anchor has to be re-read. */
function useRailAnchor() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const host = hostRef.current;
    const shell = host?.parentElement;
    if (!host || !shell) return;

    const measure = () => {
      const { top, left } = host.getBoundingClientRect();
      setAnchor((prev) => (prev.top === top && prev.left === left ? prev : { top, left }));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  return { hostRef, anchor };
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function RailChrome({ model, paletteOpen, onOpenPalette }: FeedChromePresetProps) {
  const {
    preset,
    entries,
    activeLabel,
    channelCount,
    paneRoomIds,
    activePaneIndex,
    paneCount,
    contractCount,
    highlightCount,
    discordConnected,
    telegramConfigured,
    telegramConnected,
    layoutEditMode,
    selectRoom,
    createRoom,
    toggleLayoutEditMode,
    setPreset,
  } = model;

  const { hostRef, anchor } = useRailAnchor();
  const clock = useClock();
  // Three roots (nav, room strip, footer) must stay direct children of the
  // shell's flex column — the strip is sticky, the footer is `order-last`, and
  // the host insets the pane row via a sibling selector — so the crossfade is
  // applied to each rather than to one wrapper.
  const fade = useChromeFade();

  const segment = 'flex items-center gap-snug px-comfy border-r-2 border-black/35';

  return (
    <>
      {/* Zero-height host: measures the rail's corner and insets the pane row it precedes. */}
      <div ref={hostRef} className="shrink-0 h-0 [&~*:last-child]:pl-16">
        <m.nav
          {...fade}
          aria-label="Rooms"
          className="fixed z-20 flex flex-col items-center gap-snug py-cozy border-r-2 border-oct-border bg-oct-surface overflow-y-auto"
          style={{ top: anchor.top, left: anchor.left, width: RAIL_WIDTH, bottom: STATUS_HEIGHT }}
        >
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => selectRoom(entry.id)}
              title={entry.kind === 'mentions' ? 'Mentions' : `#${entry.label}`}
              className={[
                'relative shrink-0 w-11 h-10 flex items-center justify-center rounded-cockpit border-2',
                'type-caption font-mono font-bold uppercase tracking-[0.06em] transition-colors duration-fast',
                entry.active
                  ? 'border-oct-accent bg-oct-accent-dim text-oct-accent'
                  : 'border-transparent text-oct-muted hover:border-oct-border-bright hover:text-oct-text',
              ].join(' ')}
            >
              {tileGlyph(entry)}
              {entry.unread > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] px-tight rounded-cockpit bg-oct-accent text-white type-data text-2xs font-bold leading-4 text-center">
                  {entry.unread > 99 ? '99+' : entry.unread}
                </span>
              )}
            </button>
          ))}

          <button
            type="button"
            onClick={createRoom}
            title="New room"
            className="mt-auto shrink-0 w-11 h-10 flex items-center justify-center rounded-cockpit border-2 border-transparent font-mono text-sm font-bold text-oct-border-bright hover:border-oct-border-bright hover:text-oct-accent transition-colors duration-fast"
          >
            +
          </button>
        </m.nav>
      </div>

      {paneCount <= 1 && (
        <m.div {...fade} className="sticky top-0 z-10 shrink-0 pl-16 border-y-2 border-oct-border bg-oct-surface-raised">
          <div className="flex items-center gap-cozy px-roomy py-snug type-caption font-mono uppercase tracking-[0.18em] text-oct-muted">
            <span className="shrink-0 text-oct-border-bright">▸</span>
            <button
              type="button"
              onClick={onOpenPalette}
              className="min-w-0 truncate font-bold text-oct-accent"
              title="Switch room (⌘K)"
            >
              {activeLabel}
            </button>
            {channelCount > 0 && (
              <span className="shrink-0 hidden sm:inline tabular-nums">
                · {channelCount} {channelCount === 1 ? 'Channel' : 'Channels'}
              </span>
            )}
            <span className="shrink-0 hidden sm:inline tabular-nums">· {contractCount} CA</span>
            <span className="ml-auto shrink-0 text-oct-border-bright type-data text-2xs">{clock} →</span>
          </div>
        </m.div>
      )}

      <m.div {...fade} className="order-last shrink-0 h-8 flex items-stretch px-comfy bg-oct-accent text-black type-caption font-mono font-bold uppercase tracking-[0.14em]">
        <span className={`${segment} pl-0 min-w-0`}>
          <span className="truncate">{activeLabel}</span>
        </span>

        <span className={`${segment} hidden sm:flex tabular-nums`}>{channelCount} CH</span>

        <Link
          to={`${routes.callers}?view=feed`}
          className={`${segment} tabular-nums hover:underline decoration-2 underline-offset-2`}
          title="Contract feed"
        >
          {contractCount} CA
        </Link>

        <span className={`${segment} hidden sm:flex tabular-nums`}>{highlightCount} HL</span>

        {paneCount > 1 && (
          <span className={`${segment} hidden sm:flex`} title={`${paneCount} panes open`}>
            {paneRoomIds.map((id, i) => (
              <span
                key={`${id}-${i}`}
                className={`w-2 h-2 rounded-full ${i === activePaneIndex ? 'bg-black' : 'bg-black/35'}`}
              />
            ))}
          </span>
        )}

        {layoutEditMode && (
          <button
            type="button"
            onClick={toggleLayoutEditMode}
            className={`${segment} bg-black/85 text-oct-accent`}
            title="Exit layout edit mode"
          >
            Layout
          </button>
        )}

        <span className="ml-auto flex items-center gap-comfy pl-comfy">
          {/* Connection dots carry meaning (good/warn/critical), not brand — the
              footer itself is already the accent. */}
          <span className={`flex items-center gap-snug ${discordConnected ? '' : 'text-black/45'}`}>
            <span
              className={`w-2 h-2 rounded-full border border-black/40 ${discordConnected ? 'bg-oct-good' : 'bg-oct-critical'}`}
            />
            <span className="hidden sm:inline">Discord</span>
          </span>

          {telegramConfigured && (
            <span className={`flex items-center gap-snug ${telegramConnected ? '' : 'text-black/45'}`}>
              <span
                className={`w-2 h-2 rounded-full border border-black/40 ${telegramConnected ? 'bg-oct-good' : 'bg-oct-warn'}`}
              />
              <span className="hidden sm:inline">Telegram</span>
            </span>
          )}

          <PresetSwitcher value={preset} onChange={setPreset} tone="accent" className="hidden sm:flex" />

          <button
            type="button"
            onClick={onOpenPalette}
            aria-expanded={paletteOpen}
            className={`px-snug rounded-cockpit tracking-[0.14em] ${paletteOpen ? 'bg-black/85 text-oct-accent' : ''}`}
            title="Rooms and actions (⌘K)"
          >
            ⌘K
          </button>
        </span>
      </m.div>
    </>
  );
}
