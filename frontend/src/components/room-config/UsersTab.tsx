import type { Dispatch, SetStateAction } from 'react';
import { Plus, Trash2, Send } from 'lucide-react';
import type { HighlightMode } from '../../types';
import ColorPickerWithAlpha from '../ColorPickerWithAlpha';

interface UsersTabProps {
  highlightMode: HighlightMode;
  setHighlightMode: Dispatch<SetStateAction<HighlightMode>>;
  newUserId: string;
  setNewUserId: Dispatch<SetStateAction<string>>;
  addHighlightedUser: () => void;
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
  highlightedUsers,
  removeHighlightedUser,
  highlightedUserColors,
  setHighlightedUserColors,
  userNameMap,
}: UsersTabProps) {
  return (
            <>
              <p className="text-sm text-discord-text-muted mb-4">
                Add user IDs or Telegram @usernames to highlight in this room. Their messages will be
                visually highlighted and you'll get alerts when they send messages.
              </p>

              <div className="mb-4">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-2">
                  Highlight Style
                </label>
                <div className="flex rounded overflow-hidden border border-discord-divider">
                  <button
                    onClick={() => setHighlightMode('background')}
                    className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                      highlightMode === 'background'
                        ? 'bg-discord-blurple text-white'
                        : 'bg-discord-dark text-discord-text-muted hover:text-discord-text'
                    }`}
                  >
                    Background
                  </button>
                  <button
                    onClick={() => setHighlightMode('username')}
                    className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                      highlightMode === 'username'
                        ? 'bg-discord-blurple text-white'
                        : 'bg-discord-dark text-discord-text-muted hover:text-discord-text'
                    }`}
                  >
                    Username Color
                  </button>
                </div>
                <p className="text-xs text-discord-text-muted mt-1.5">
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
                  className="flex-1 bg-discord-dark border-none rounded px-3 py-2 text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                />
                <button
                  onClick={addHighlightedUser}
                  className="px-3 py-2 bg-discord-blurple hover:bg-discord-blurple-hover rounded text-sm text-white transition-colors"
                >
                  <Plus size={16} />
                </button>
              </div>
              <div className="space-y-1">
                {highlightedUsers.length === 0 && (
                  <p className="text-sm text-discord-text-muted text-center py-4">
                    No highlighted users for this room.
                  </p>
                )}
                {highlightedUsers.map((uid) => {
                  const isTgUser = uid.startsWith('@');
                  return (
                  <div
                    key={uid}
                    className="flex items-center justify-between px-3 py-2 bg-discord-dark rounded"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isTgUser && <Send size={12} className="text-[#2AABEE] shrink-0" />}
                      <span className={`text-sm ${isTgUser ? 'text-[#2AABEE]' : 'font-mono'}`} style={isTgUser ? undefined : { color: highlightedUserColors[uid] || '#f2f3f5' }}>{uid}</span>
                      {!isTgUser && userNameMap.has(uid) && (
                        <span className="text-[11px] text-discord-text-muted">{userNameMap.get(uid)}</span>
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
                          className="text-[10px] text-discord-text-muted hover:text-discord-text"
                          title="Reset to default"
                        >
                          Reset
                        </button>
                      )}
                      <button
                        onClick={() => removeHighlightedUser(uid)}
                        className="text-discord-text-muted hover:text-discord-red shrink-0"
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
