import { Plus, Trash2, Send } from 'lucide-react';
import BulkAddUsers from '../../BulkAddUsers';
import type { SettingsForm } from '../useSettingsForm';

export default function UsersSection({ form }: { form: SettingsForm }) {
  const { userNameMap, globalUsers, newUserId, setNewUserId, addGlobalUser, addGlobalUsers, removeGlobalUser } = form;
  return (
              <>
                <div>
                  <h3 className="font-display text-2xl sm:text-3xl tracking-tight text-oct-text mb-1">Global Highlighted Users</h3>
                  <p className="text-xs sm:text-sm text-oct-muted mb-3 sm:mb-4">
                    These users will be highlighted in all rooms. Use Discord user IDs or Telegram @usernames.
                  </p>
                  <div className="flex gap-2 mb-4">
                    <input
                      type="text"
                      value={newUserId}
                      onChange={(e) => setNewUserId(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addGlobalUser()}
                      placeholder="User ID or @telegram_username"
                      className="flex-1 oct-input px-3 py-2 text-sm"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      data-form-type="other"
                    />
                    <button
                      onClick={addGlobalUser}
                      className="oct-btn-primary px-3 py-2 text-sm"
                    >
                      <Plus size={16} />
                    </button>
                  </div>

                  <BulkAddUsers
                    existing={globalUsers}
                    onAdd={addGlobalUsers}
                    variant="settings"
                    noun="global highlighted users"
                  />

                  <div className="space-y-1">
                    {globalUsers.length === 0 && (
                      <p className="text-sm text-oct-muted text-center py-4">
                        No global highlighted users.
                      </p>
                    )}
                    {globalUsers.map((uid) => {
                      const isTgUser = uid.startsWith('@');
                      return (
                      <div key={uid} className="flex items-center justify-between gap-2 px-2 sm:px-3 py-2 rounded-oct border border-oct-border bg-oct-surface-raised oct-row-hover">
                        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                          {isTgUser && <Send size={12} className="text-oct-accent shrink-0" />}
                          <span className={`text-xs sm:text-sm truncate font-mono ${isTgUser ? 'text-oct-accent' : 'text-oct-text'}`}>{uid}</span>
                          {!isTgUser && userNameMap.has(uid) && (
                            <span className="text-[11px] sm:text-xs text-oct-muted shrink-0">{userNameMap.get(uid)}</span>
                          )}
                        </div>
                        <button
                          onClick={() => removeGlobalUser(uid)}
                          className="text-oct-muted hover:text-oct-flame shrink-0"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      );
                    })}
                  </div>
                </div>
              </>
  );
}
