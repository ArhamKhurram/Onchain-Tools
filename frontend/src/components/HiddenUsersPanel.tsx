import { EyeOff, X, Trash2 } from 'lucide-react';

/** One hidden-user row, resolved to its owning guild/channel for display + unhide.
 *  A `global` row is hidden across every channel, so its guild/channel fields
 *  are placeholders and only exist to key the list. */
export interface HiddenUserEntry {
  scope: 'channel' | 'global';
  userId: string;
  displayName: string;
  guildId: string | null;
  channelId: string;
  channelName: string;
  guildName: string | null;
}

interface HiddenUsersPanelProps {
  entries: HiddenUserEntry[];
  onClose: () => void;
  onUnhide: (entry: HiddenUserEntry) => void;
}

/**
 * Collapsible panel listing the users hidden across a room's channels, each with
 * an unhide control. Presentational — the pane owns the open/closed state and the
 * derivation of `entries`.
 */
export default function HiddenUsersPanel({ entries, onClose, onUnhide }: HiddenUsersPanelProps) {
  return (
    <div className="border-b-2 border-oct-border bg-oct-surface px-3 sm:px-4 py-3 shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-oct-muted">
          Hidden Users
        </span>
        <button
          onClick={onClose}
          className="text-oct-muted hover:text-oct-accent transition-colors duration-100"
        >
          <X size={14} />
        </button>
      </div>
      <div className="space-y-1 max-h-[200px] overflow-y-auto">
        {entries.map((entry) => (
          <div
            key={`${entry.scope}:${entry.guildId}:${entry.channelId}:${entry.userId}`}
            className="flex items-center justify-between gap-2 px-2 sm:px-2.5 py-1.5 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised"
          >
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <EyeOff size={12} className="shrink-0 text-oct-flame/70" />
              <span className="text-sm text-oct-text font-medium truncate">{entry.displayName}</span>
              <span className="text-[10px] text-oct-muted font-mono hidden sm:inline">{entry.userId}</span>
              <span className="font-mono text-[10px] text-oct-muted truncate hidden sm:inline">
                {entry.scope === 'global'
                  ? 'all channels'
                  : `${entry.guildName ? `${entry.guildName} / ` : ''}#${entry.channelName}`}
              </span>
            </div>
            <button
              onClick={() => onUnhide(entry)}
              className="shrink-0 text-oct-muted hover:text-oct-flame transition-colors duration-100"
              title="Unhide user"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
