import { Link } from 'react-router-dom';
import { m } from '../../../lib/motion';
import { routes } from '../../../lib/routes';
import { useChromeFade } from '../chromeMotion';
import PresetSwitcher from '../PresetSwitcher';
import type { FeedChromePresetProps } from '../feedChromeContract';

const CELL = 'shrink-0 -mr-[2px] last:mr-0 px-comfy py-snug rounded-cockpit border-2 type-caption font-mono uppercase tracking-[0.12em] leading-none';
const CELL_IDLE = 'border-oct-border text-oct-muted';
const CELL_HOT = 'relative z-10 border-oct-accent text-oct-accent font-bold';
const ACTION = `${CELL} transition-colors duration-fast`;
const ACTION_IDLE = 'border-oct-border text-oct-muted hover:border-oct-accent hover:text-oct-accent';
const EYEBROW = 'type-caption font-mono font-bold uppercase tracking-[0.24em] text-oct-muted';

export default function MastheadChrome({ model, paletteOpen, onOpenPalette }: FeedChromePresetProps) {
  const {
    preset,
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
    setPreset,
  } = model;
  const fade = useChromeFade();

  const roomIndex = rooms.findIndex((r) => r.id === activeRoomId);
  const kicker =
    roomIndex >= 0
      ? `[ Room ${String(roomIndex + 1).padStart(2, '0')} ]`
      : activeRoomId === 'mentions'
        ? '[ Mentions ]'
        : '[ Feed ]';
  const displayName = activeLabel.replace(/^[#@]/, '');

  return (
    <m.div {...fade} className="shrink-0 flex max-h-[240px] border-b-2 border-oct-border bg-oct-bg">
      <aside className="hidden md:flex w-[210px] shrink-0 flex-col border-r-2 border-oct-border bg-oct-surface">
        <p className={`shrink-0 px-comfy pt-comfy pb-cozy ${EYEBROW}`}>
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
                  'w-full flex items-center gap-cozy pl-cozy pr-comfy py-cozy text-left border-l-4 type-label font-mono font-normal uppercase tracking-[0.06em] transition-colors duration-fast',
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
                  <span className="shrink-0 min-w-[20px] px-tight py-hair rounded-cockpit bg-oct-accent text-white text-center type-data text-2xs font-bold leading-none">
                    {entry.unread > 99 ? '99+' : entry.unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="shrink-0 border-t-2 border-oct-border pb-cozy">
          <p className={`px-comfy pt-cozy pb-snug ${EYEBROW}`}>
            Sources
          </p>
          {/* Connection state is MEANING: good/warn/critical, never the brand
              accent (red in the dark theme). */}
          <div className="flex items-center gap-cozy px-comfy py-tight type-caption font-mono uppercase tracking-[0.1em] text-oct-muted">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${discordConnected ? 'bg-oct-good' : 'bg-oct-critical'}`}
            />
            <span className="flex-1 truncate">Discord</span>
            <span className={discordConnected ? 'text-oct-good' : 'text-oct-critical'}>
              {discordConnected ? 'On' : 'Off'}
            </span>
          </div>
          {telegramConfigured && (
            <div className="flex items-center gap-cozy px-comfy py-tight type-caption font-mono uppercase tracking-[0.1em] text-oct-muted">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${telegramConnected ? 'bg-oct-good' : 'bg-oct-warn'}`}
              />
              <span className="flex-1 truncate">Telegram</span>
              <span className={telegramConnected ? 'text-oct-good' : 'text-oct-warn'}>
                {telegramConnected ? 'On' : 'Off'}
              </span>
            </div>
          )}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col justify-center gap-comfy px-roomy sm:px-section py-roomy">
        <div className="flex items-center gap-comfy type-caption font-mono font-bold uppercase tracking-[0.26em]">
          <span className="shrink-0 text-oct-accent">{kicker}</span>
          <span className={`shrink-0 ${discordConnected ? 'text-oct-muted' : 'text-oct-warn'}`}>
            · {discordConnected ? 'Live' : 'Offline'}
          </span>
          {paneCount > 1 && (
            <span className="flex items-center gap-tight shrink-0" title={`${paneCount} panes open`}>
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
          className="min-w-0 text-left font-display type-display font-normal sm:text-[40px] leading-none tracking-tight text-oct-text truncate hover:text-oct-accent transition-colors duration-fast"
          title="Switch room (⌘K)"
        >
          {displayName}
        </button>

        <div className="flex items-center flex-wrap gap-y-cozy">
          <span className={`${CELL} ${CELL_IDLE} tabular-nums`}>
            {channelCount} {channelCount === 1 ? 'Channel' : 'Channels'}
          </span>

          <Link
            to={`${routes.callers}?view=feed`}
            className={`${CELL} ${CELL_IDLE} tabular-nums transition-colors duration-fast hover:border-oct-accent hover:text-oct-accent`}
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

          <span className="ml-auto flex items-center gap-comfy pl-comfy">
            <PresetSwitcher value={preset} onChange={setPreset} className="hidden sm:flex" />
            <span className="flex items-center">
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
          </span>
        </div>
      </div>
    </m.div>
  );
}
