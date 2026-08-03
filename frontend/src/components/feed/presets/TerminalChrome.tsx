import { Link } from 'react-router-dom';
import { routes } from '../../../lib/routes';
import type { FeedChromePresetProps } from '../feedChromeContract';

export default function TerminalChrome({ model, paletteOpen, onOpenPalette }: FeedChromePresetProps) {
  const {
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
  } = model;

  return (
    <div className="shrink-0 h-11 px-2 sm:px-3 flex items-center gap-2 sm:gap-3 border-b-2 border-oct-border bg-oct-surface">
      <span className="shrink-0 px-2 py-1 rounded-cockpit bg-oct-accent text-white font-mono text-[11px] font-bold uppercase tracking-[0.16em] leading-none">
        OCT
      </span>

      <button
        type="button"
        onClick={onOpenPalette}
        className="min-w-0 flex items-center gap-2 sm:gap-2.5 font-mono text-[11px] sm:text-[13px] tracking-[0.1em] uppercase"
        title="Switch room (⌘K)"
      >
        <span className="shrink-0 text-oct-muted hidden sm:inline">Feed</span>
        <span className="shrink-0 text-oct-border-bright hidden sm:inline">/</span>
        <span className="truncate font-bold text-oct-accent">{activeLabel}</span>
        {channelCount > 0 && (
          <>
            <span className="shrink-0 text-oct-border-bright">/</span>
            <span className="shrink-0 text-oct-muted tabular-nums">{channelCount}CH</span>
          </>
        )}
      </button>

      {paneCount > 1 && (
        <div className="hidden sm:flex items-center gap-1 shrink-0" title={`${paneCount} panes open`}>
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

      <div className="ml-auto flex items-center gap-3 sm:gap-5 shrink-0 font-mono text-[11px] sm:text-xs tracking-[0.1em] uppercase">
        {layoutEditMode && (
          <button
            type="button"
            onClick={toggleLayoutEditMode}
            className="hidden sm:inline-block px-2 py-0.5 rounded-cockpit border-2 border-oct-accent bg-oct-accent-dim text-oct-accent font-bold tracking-[0.14em]"
            title="Exit layout edit mode"
          >
            Layout
          </button>
        )}

        <Link
          to={`${routes.callers}?view=feed`}
          className="group hidden sm:flex items-center gap-1.5"
          title="Contract feed"
        >
          <span className="text-oct-muted group-hover:text-oct-accent transition-colors duration-100">CA</span>
          <span className="font-bold tabular-nums text-oct-text group-hover:text-oct-accent transition-colors duration-100">
            {contractCount}
          </span>
        </Link>

        <span className="hidden md:flex items-center gap-1.5" title="Highlighted users in this room">
          <span className="text-oct-muted">HL</span>
          <span className="font-bold tabular-nums text-oct-accent">{highlightCount}</span>
        </span>

        <span className="flex items-center gap-1.5" title="Unread messages">
          <span className="text-oct-muted">Unread</span>
          <span className="font-bold tabular-nums text-oct-text">{unreadTotal}</span>
        </span>

        <span className="flex items-center gap-1.5 shrink-0">
          <span
            className={`w-2 h-2 rounded-full ${discordConnected ? 'bg-oct-green' : 'bg-oct-accent'}`}
            title={discordConnected ? 'Discord connected' : 'Discord disconnected'}
          />
          {telegramConfigured && (
            <span
              className={`w-2 h-2 rounded-full ${telegramConnected ? 'bg-oct-telegram' : 'bg-oct-yellow'}`}
              title={telegramConnected ? 'Telegram connected' : 'Telegram disconnected'}
            />
          )}
        </span>

        <button
          type="button"
          onClick={onOpenPalette}
          aria-expanded={paletteOpen}
          className={[
            'shrink-0 px-2 py-0.5 rounded-cockpit border-2 tracking-[0.14em] transition-colors duration-100',
            paletteOpen
              ? 'border-oct-accent text-oct-accent'
              : 'border-oct-border text-oct-muted hover:border-oct-accent hover:text-oct-accent',
          ].join(' ')}
          title="Rooms and actions (⌘K)"
        >
          ⌘K
        </button>
      </div>
    </div>
  );
}
