import type { Dispatch, SetStateAction } from 'react';
import { Plus, Trash2, Filter } from 'lucide-react';
import BulkAddUsers from '../BulkAddUsers';

interface FilterTabProps {
  filterEnabled: boolean;
  setFilterEnabled: Dispatch<SetStateAction<boolean>>;
  filteredUsers: string[];
  newFilterUser: string;
  setNewFilterUser: Dispatch<SetStateAction<string>>;
  addFilteredUser: () => void;
  addFilteredUsers: (users: string[]) => void;
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
  addFilteredUsers,
  removeFilteredUser,
  userNameMap,
}: FilterTabProps) {
  return (
            <>
              <p className="text-sm text-oct-muted mb-4">
                When enabled, only messages from these users will be shown in this room.
                You can add Discord user IDs or usernames. Tip: click a username in chat to copy their ID.
              </p>

              <label className="flex items-center gap-3 cursor-pointer mb-4">
                <div
                  className={`w-10 h-5 rounded-full border-2 border-oct-border transition-colors duration-100 relative shrink-0 ${
                    filterEnabled ? 'bg-oct-green' : 'bg-oct-surface-raised'
                  }`}
                  onClick={() => setFilterEnabled(!filterEnabled)}
                >
                  <div
                    className={`absolute top-0 w-4 h-4 bg-oct-text rounded-full transition-transform duration-100 ${
                      filterEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </div>
                <span className="text-sm text-oct-text">
                  {filterEnabled ? 'Filter active' : 'Filter disabled'}
                  {filterEnabled && filteredUsers.length === 0 && (
                    <span className="text-oct-yellow ml-2">(add users below)</span>
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
                  className="flex-1 px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  data-form-type="other"
                />
                <button
                  onClick={addFilteredUser}
                  className="brutal-btn px-3 py-2 text-sm"
                >
                  <Plus size={16} />
                </button>
              </div>

              <BulkAddUsers
                existing={filteredUsers}
                onAdd={addFilteredUsers}
                noun="filtered users"
              />

              <div className="space-y-1">
                {filteredUsers.length === 0 && (
                  <p className="text-sm text-oct-muted text-center py-4">
                    No filtered users for this room.
                  </p>
                )}
                {filteredUsers.map((uid) => (
                  <div
                    key={uid}
                    className="flex items-center justify-between gap-2 px-2 sm:px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface"
                  >
                    <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                      <Filter size={12} className="shrink-0 text-oct-green" />
                      <span className="text-xs sm:text-sm text-oct-text font-mono truncate">{uid}</span>
                      {userNameMap.has(uid) && (
                        <span className="text-[10px] sm:text-[11px] text-oct-muted shrink-0">{userNameMap.get(uid)}</span>
                      )}
                    </div>
                    <button
                      onClick={() => removeFilteredUser(uid)}
                      className="text-oct-muted hover:text-oct-flame shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </>
  );
}
