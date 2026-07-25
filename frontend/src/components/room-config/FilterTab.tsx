import type { Dispatch, SetStateAction } from 'react';
import { Plus, Trash2, Filter } from 'lucide-react';

interface FilterTabProps {
  filterEnabled: boolean;
  setFilterEnabled: Dispatch<SetStateAction<boolean>>;
  filteredUsers: string[];
  newFilterUser: string;
  setNewFilterUser: Dispatch<SetStateAction<string>>;
  addFilteredUser: () => void;
  removeFilteredUser: (user: string) => void;
  userNameMap: Map<string, string>;
}

export default function FilterTab({
  filterEnabled,
  setFilterEnabled,
  filteredUsers,
  newFilterUser,
  setNewFilterUser,
  addFilteredUser,
  removeFilteredUser,
  userNameMap,
}: FilterTabProps) {
  return (
            <>
              <p className="text-sm text-discord-text-muted mb-4">
                When enabled, only messages from these users will be shown in this room.
                You can add Discord user IDs or usernames. Tip: click a username in chat to copy their ID.
              </p>

              <label className="flex items-center gap-3 cursor-pointer mb-4">
                <div
                  className={`w-10 h-5 rounded-full transition-colors relative ${
                    filterEnabled ? 'bg-discord-green' : 'bg-discord-input'
                  }`}
                  onClick={() => setFilterEnabled(!filterEnabled)}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                      filterEnabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </div>
                <span className="text-sm text-discord-text">
                  {filterEnabled ? 'Filter active' : 'Filter disabled'}
                  {filterEnabled && filteredUsers.length === 0 && (
                    <span className="text-discord-yellow ml-2">(add users below)</span>
                  )}
                </span>
              </label>

              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={newFilterUser}
                  onChange={(e) => setNewFilterUser(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addFilteredUser()}
                  placeholder="User ID or username"
                  className="flex-1 bg-discord-dark border-none rounded px-3 py-2 text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                />
                <button
                  onClick={addFilteredUser}
                  className="px-3 py-2 bg-discord-blurple hover:bg-discord-blurple-hover rounded text-sm text-white transition-colors"
                >
                  <Plus size={16} />
                </button>
              </div>
              <div className="space-y-1">
                {filteredUsers.length === 0 && (
                  <p className="text-sm text-discord-text-muted text-center py-4">
                    No filtered users for this room.
                  </p>
                )}
                {filteredUsers.map((uid) => (
                  <div
                    key={uid}
                    className="flex items-center justify-between px-3 py-2 bg-discord-dark rounded"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Filter size={12} className="shrink-0 text-discord-green" />
                      <span className="text-sm text-discord-text font-mono truncate">{uid}</span>
                      {userNameMap.has(uid) && (
                        <span className="text-[11px] text-discord-text-muted">{userNameMap.get(uid)}</span>
                      )}
                    </div>
                    <button
                      onClick={() => removeFilteredUser(uid)}
                      className="text-discord-text-muted hover:text-discord-red shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </>
  );
}
