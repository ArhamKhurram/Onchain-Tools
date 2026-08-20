import type { Dispatch, SetStateAction } from 'react';
import { Plus, Trash2, Send } from 'lucide-react';
import type { HighlightMode } from '../../types';
import ColorPickerWithAlpha from '../ColorPickerWithAlpha';
import BulkAddUsers from '../BulkAddUsers';

interface UsersTabProps {
  highlightMode: HighlightMode;
  setHighlightMode: Dispatch<SetStateAction<HighlightMode>>;
  newUserId: string;
  setNewUserId: Dispatch<SetStateAction<string>>;
  addHighlightedUser: () => void;
  addHighlightedUsers: (userIds: string[]) => void;
  highlightedUsers: string[];
  removeHighlightedUser: (userId: string) => void;
  highlightedUserColors: Record<string, string>;
  setHighlightedUserColors: Dispatch<SetStateAction<Record<string, string>>>;
  userNameMap: Map<string, string>;
}

export default function UsersTab({
  highlightMode,
  setHighlightMode,
  newUserId,
  setNewUserId,
  addHighlightedUser,
  addHighlightedUsers,
  highlightedUsers,
  removeHighlightedUser,
  highlightedUserColors,
  setHighlightedUserColors,
  userNameMap,
}: UsersTabProps) {
  return (
            <>
              <p className="text-sm text-oct-muted mb-4">
                Add user IDs or Telegram @usernames to highlight in this room. Their messages will be
                visually highlighted and you'll get alerts when they send messages.
              </p>

              <div className="mb-4">
                <label className="block font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-oct-muted mb-2">
                  Highlight Style
                </label>
                <div className="flex rounded-cockpit overflow-hidden border-2 border-oct-border divide-x-2 divide-oct-border">
                  <button
                    onClick={() => setHighlightMode('background')}
                    className={`flex-1 px-3 py-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                      highlightMode === 'background'
                        ? 'bg-oct-accent text-white'
                        : 'bg-oct-bg text-oct-muted hover:text-oct-text'
                    }`}
                  >
                    Background
                  </button>
                  <button
                    onClick={() => setHighlightMode('username')}
                    className={`flex-1 px-3 py-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                      highlightMode === 'username'
                        ? 'bg-oct-accent text-white'
                        : 'bg-oct-bg text-oct-muted hover:text-oct-text'
                    }`}
                  >
                    Username Color
                  </button>
                </div>
                <p className="text-xs text-oct-muted mt-1.5">
                  {highlightMode === 'background'
                    ? 'Highlighted messages get a colored background and left border.'
                    : 'Only the username is colored (like a Discord role) — no background change.'}
                </p>
              </div>

              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={newUserId}
                  onChange={(e) => setNewUserId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addHighlightedUser()}
                  placeholder="Discord User ID or @telegram_username"
                  className="flex-1 px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                />
                <button
                  onClick={addHighlightedUser}
                  className="brutal-btn px-3 py-2 text-sm"
                >
                  <Plus size={16} />
                </button>
              </div>

              <BulkAddUsers
                existing={highlightedUsers}
                onAdd={addHighlightedUsers}
                noun="highlighted users"
              />

              <div className="space-y-1">
                {highlightedUsers.length === 0 && (
                  <p className="text-sm text-oct-muted text-center py-4">
                    No highlighted users for this room.
                  </p>
                )}
                {highlightedUsers.map((uid) => {
                  const isTgUser = uid.startsWith('@');
                  return (
                  <div
                    key={uid}
                    className="flex items-center justify-between gap-2 px-2 sm:px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface"
                  >
                    <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                      {isTgUser && <Send size={12} className="text-oct-telegram shrink-0" />}
                      <span
                        className={`text-xs sm:text-sm font-mono truncate ${
                          isTgUser
                            ? 'text-oct-accent'
                            : highlightedUserColors[uid]
                              ? ''
                              : 'text-oct-text'
                        }`}
                        style={!isTgUser && highlightedUserColors[uid] ? { color: highlightedUserColors[uid] } : undefined}
                      >{uid}</span>
                      {!isTgUser && userNameMap.has(uid) && (
                        <span className="text-[10px] sm:text-[11px] text-oct-muted shrink-0">{userNameMap.get(uid)}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <ColorPickerWithAlpha
                        value={highlightedUserColors[uid] || '#5865f2'}
                        onChange={(c) => setHighlightedUserColors((prev) => ({ ...prev, [uid]: c }))}
                        defaultColor="#5865f2"
                      />
                      {highlightedUserColors[uid] && (
                        <button
                          onClick={() => setHighlightedUserColors((prev) => { const next = { ...prev }; delete next[uid]; return next; })}
                          className="font-mono text-[10px] font-bold uppercase tracking-wide text-oct-muted hover:text-oct-text"
                          title="Reset to default"
                        >
                          Reset
                        </button>
                      )}
                      <button
                        onClick={() => removeHighlightedUser(uid)}
                        className="text-oct-muted hover:text-oct-flame shrink-0"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            </>
  );
}
