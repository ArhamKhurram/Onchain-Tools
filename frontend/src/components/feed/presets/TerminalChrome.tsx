import { Link } from 'react-router-dom';
import { m } from '../../../lib/motion';
import { routes } from '../../../lib/routes';
import { useChromeFade } from '../chromeMotion';
import PresetSwitcher from '../PresetSwitcher';
import type { FeedChromePresetProps } from '../feedChromeContract';

export default function TerminalChrome({ model, paletteOpen, onOpenPalette }: FeedChromePresetProps) {
  const {
    preset,
    activeLabel,
    channelCount,
    paneRoomIds,
    activePaneIndex,
    paneCount,
    contractCount,
    highlightCount,
    unreadTotal,
    discordConnected,
    telegramConfigured,
    telegramConnected,
    layoutEditMode,
    toggleLayoutEditMode,
    setPreset,
  } = model;
  const fade = useChromeFade();

  return (
    <m.div {...fade} className="shrink-0 h-11 px-cozy sm:px-comfy flex items-center gap-cozy sm:gap-comfy border-b-2 border-oct-border bg-oct-surface">
      <span className="shrink-0 px-cozy py-tight rounded-cockpit bg-oct-accent text-white type-caption font-mono font-bold uppercase tracking-[0.16em] leading-none">
        OCT
      </span>

      <button
        type="button"
        onClick={onOpenPalette}
        className="min-w-0 flex items-center gap-cozy type-label font-mono font-normal tracking-[0.1em] uppercase"
        title="Switch room (⌘K)"
      >
        <span className="shrink-0 text-oct-muted hidden sm:inline">Feed</span>
        <span className="shrink-0 text-oct-border-bright hidden sm:inline">/</span>
        <span className="truncate font-bold text-oct-accent">{activeLabel}</span>
        {channelCount > 0 && (
          <>
            <span className="shrink-0 text-oct-border-bright">/</span>
            <span className="shrink-0 type-data text-oct-muted">{channelCount}CH</span>
          </>
        )}
      </button>

      {paneCount > 1 && (
        <div className="hidden sm:flex items-center gap-tight shrink-0" title={`${paneCount} panes open`}>
          {paneRoomIds.map((id, i) => (
            <span
              key={`${id}-${i}`}
              className={[
                'w-2 h-2 rounded-full',
                i === activePaneIndex ? 'bg-oct-accent' : 'bg-oct-border-bright',
              ].join(' ')}
            />
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-comfy sm:gap-roomy shrink-0 type-caption font-mono tracking-[0.1em] uppercase">
        {layoutEditMode && (
          <button
            type="button"
            onClick={toggleLayoutEditMode}
            className="hidden sm:inline-block px-cozy py-hair rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-oct-accent font-bold tracking-[0.14em]"
            title="Exit layout edit mode"
          >
            Layout
          </button>
        )}

        <Link
          to={`${routes.callers}?view=feed`}
          className="group hidden sm:flex items-center gap-snug"
          title="Contract feed"
        >
          <span className="text-oct-muted group-hover:text-oct-accent transition-colors duration-fast">CA</span>
          <span className="type-data font-bold text-oct-text group-hover:text-oct-accent transition-colors duration-fast">
            {contractCount}
          </span>
        </Link>

        <span className="hidden md:flex items-center gap-snug" title="Highlighted users in this room">
          <span className="text-oct-muted">HL</span>
          <span className="type-data font-bold text-oct-accent">{highlightCount}</span>
        </span>

        <span className="flex items-center gap-snug" title="Unread messages">
          <span className="text-oct-muted">Unread</span>
          <span className="type-data font-bold text-oct-text">{unreadTotal}</span>
        </span>

        {/* Connection state is MEANING, not brand: good/warn/critical rather
            than the accent, which is red in the dark theme and would read as
            "down" while connected. */}
        <span className="flex items-center gap-snug shrink-0">
          <span
            className={`w-2 h-2 rounded-full ${discordConnected ? 'bg-oct-good' : 'bg-oct-critical'}`}
            title={discordConnected ? 'Discord connected' : 'Discord disconnected'}
          />
          {telegramConfigured && (
            <span
              className={`w-2 h-2 rounded-full ${telegramConnected ? 'bg-oct-good' : 'bg-oct-warn'}`}
              title={telegramConnected ? 'Telegram connected' : 'Telegram disconnected'}
            />
          )}
        </span>

        <PresetSwitcher value={preset} onChange={setPreset} className="hidden sm:flex" />

        <button
          type="button"
          onClick={onOpenPalette}
          aria-expanded={paletteOpen}
          className={[
            'shrink-0 px-cozy py-hair rounded-cockpit border-2 tracking-[0.14em] transition-colors duration-fast',
            paletteOpen
              ? 'border-oct-accent text-oct-accent'
              : 'border-oct-border text-oct-muted hover:border-oct-accent hover:text-oct-accent',
          ].join(' ')}
          title="Rooms and actions (⌘K)"
        >
          ⌘K
        </button>
      </div>
    </m.div>
  );
}
