import { Link } from 'react-router-dom';
import { routes } from '../../../lib/routes';
import type { FeedChromePresetProps } from '../feedChromeContract';

const CELL = 'shrink-0 -mr-[2px] last:mr-0 px-3 py-1.5 rounded-cockpit border-2 font-mono text-[11px] uppercase tracking-[0.12em] leading-none';
const CELL_IDLE = 'border-oct-border text-oct-muted';
const CELL_HOT = 'relative z-10 border-oct-accent text-oct-accent font-bold';
const ACTION = `${CELL} transition-colors duration-100`;
const ACTION_IDLE = 'border-oct-border text-oct-muted hover:border-oct-accent hover:text-oct-accent';

export default function MastheadChrome({ model, paletteOpen, onOpenPalette }: FeedChromePresetProps) {
  const {
    rooms,
    entries,
    activeRoom,
    activeRoomId,
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
    selectRoom,
    createRoom,
    configureActiveRoom,
    toggleLayoutEditMode,
  } = model;

  const roomIndex = rooms.findIndex((r) => r.id === activeRoomId);
  const kicker =
    roomIndex >= 0
      ? `[ Room ${String(roomIndex + 1).padStart(2, '0')} ]`
      : activeRoomId === 'mentions'
        ? '[ Mentions ]'
        : '[ Feed ]';
  const displayName = activeLabel.replace(/^[#@]/, '');

  return (
    <div className="shrink-0 flex max-h-[240px] border-b-2 border-oct-border bg-oct-bg">
      <aside className="hidden md:flex w-[210px] shrink-0 flex-col border-r-2 border-oct-border bg-oct-surface">
        <p className="shrink-0 px-3.5 pt-3 pb-2 font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-oct-muted">
          Rooms
        </p>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {entries.map((entry) => {
            const focused = entry.id === activeRoomId;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => selectRoom(entry.id)}
                className={[
                  'w-full flex items-center gap-2 pl-2.5 pr-3.5 py-2 text-left border-l-4 font-mono text-xs uppercase tracking-[0.06em] transition-colors duration-100',
                  focused
                    ? 'border-oct-accent bg-oct-accent-dim text-oct-accent font-bold'
                    : entry.active
                      ? 'border-oct-border-bright text-oct-text hover:text-oct-accent'
                      : 'border-transparent text-oct-muted hover:text-oct-accent',
                ].join(' ')}
                title={entry.active && !focused ? `${entry.label} (open in another pane)` : entry.label}
              >
                <span className={`shrink-0 ${focused ? 'text-oct-accent' : 'text-oct-border-bright'}`}>
                  {entry.kind === 'mentions' ? '@' : '#'}
                </span>
                <span className="flex-1 truncate">{entry.label}</span>
                {entry.unread > 0 && (
                  <span className="shrink-0 min-w-[20px] px-1 py-0.5 rounded-cockpit bg-oct-accent text-white text-center text-[10px] font-bold leading-none tabular-nums">
                    {entry.unread > 99 ? '99+' : entry.unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="shrink-0 border-t-2 border-oct-border pb-2">
          <p className="px-3.5 pt-2.5 pb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-oct-muted">
            Sources
          </p>
          <div className="flex items-center gap-2 px-3.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-oct-muted">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${discordConnected ? 'bg-oct-green' : 'bg-oct-accent'}`}
            />
            <span className="flex-1 truncate">Discord</span>
            <span className={discordConnected ? 'text-oct-green' : 'text-oct-accent'}>
              {discordConnected ? 'On' : 'Off'}
            </span>
          </div>
          {telegramConfigured && (
            <div className="flex items-center gap-2 px-3.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-oct-telegram">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${telegramConnected ? 'bg-oct-telegram' : 'bg-oct-yellow'}`}
              />
              <span className="flex-1 truncate">Telegram</span>
              <span className={telegramConnected ? 'text-oct-telegram' : 'text-oct-yellow'}>
                {telegramConnected ? 'On' : 'Off'}
              </span>
            </div>
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col justify-center gap-3 px-4 sm:px-6 py-4">
        <div className="flex items-center gap-3 font-mono text-[11px] font-bold uppercase tracking-[0.26em]">
          <span className="shrink-0 text-oct-accent">{kicker}</span>
          <span className={`shrink-0 ${discordConnected ? 'text-oct-muted' : 'text-oct-yellow'}`}>
            · {discordConnected ? 'Live' : 'Offline'}
          </span>
          {paneCount > 1 && (
            <span className="flex items-center gap-1 shrink-0" title={`${paneCount} panes open`}>
              {paneRoomIds.map((id, i) => (
                <span
                  key={`${id}-${i}`}
                  className={[
                    'w-2 h-2 rounded-full',
                    i === activePaneIndex ? 'bg-oct-accent' : 'bg-oct-border-bright',
                  ].join(' ')}
                />
              ))}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onOpenPalette}
          aria-expanded={paletteOpen}
          className="min-w-0 text-left font-display text-3xl sm:text-[40px] leading-none tracking-tight text-oct-text truncate hover:text-oct-accent transition-colors duration-100"
          title="Switch room (⌘K)"
        >
          {displayName}
        </button>

        <div className="flex items-center flex-wrap gap-y-2">
          <span className={`${CELL} ${CELL_IDLE} tabular-nums`}>
            {channelCount} {channelCount === 1 ? 'Channel' : 'Channels'}
          </span>

          <Link
            to={`${routes.callers}?view=feed`}
            className={`${CELL} ${CELL_IDLE} tabular-nums transition-colors duration-100 hover:border-oct-accent hover:text-oct-accent`}
            title="Contract feed"
          >
            {contractCount} CA
          </Link>

          <span
            className={`${CELL} ${highlightCount > 0 ? CELL_HOT : CELL_IDLE} tabular-nums`}
            title="Highlighted users in this room"
          >
            {highlightCount} Highlighted
          </span>

          <span className={`hidden lg:inline-block ${CELL} ${CELL_IDLE} tabular-nums`} title="Unread messages">
            {unreadTotal} Unread
          </span>

          <span className="ml-auto flex items-center pl-3">
            <button
              type="button"
              onClick={onOpenPalette}
              aria-expanded={paletteOpen}
              className={`${ACTION} ${paletteOpen ? 'relative z-10 border-oct-accent text-oct-accent' : ACTION_IDLE}`}
              title="Rooms and actions (⌘K)"
            >
              Search
            </button>
            <button
              type="button"
              onClick={configureActiveRoom}
              disabled={!activeRoom}
              className={`${ACTION} ${activeRoom ? ACTION_IDLE : 'border-oct-border text-oct-muted/50 cursor-not-allowed'}`}
              title="Room settings"
            >
              Config
            </button>
            <button
              type="button"
              onClick={createRoom}
              className={`${ACTION} ${ACTION_IDLE}`}
              title="Create room"
            >
              + Room
            </button>
            <button
              type="button"
              onClick={toggleLayoutEditMode}
              aria-pressed={layoutEditMode}
              className={`${ACTION} ${
                layoutEditMode
                  ? 'relative z-10 border-oct-accent bg-oct-accent-dim text-oct-accent font-bold'
                  : ACTION_IDLE
              }`}
              title={layoutEditMode ? 'Exit layout edit mode' : 'Edit pane layout'}
            >
              Layout
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
