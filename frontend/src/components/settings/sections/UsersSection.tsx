import { Plus, Trash2, Send } from 'lucide-react';
import BulkAddUsers from '../../BulkAddUsers';
import { cn } from '../../../lib/utils';
import { EmptyNote, FieldRow, INPUT_CLASS, RemoveButton, SectionHeader } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

export default function UsersSection({ form }: { form: SettingsForm }) {
  const { userNameMap, globalUsers, newUserId, setNewUserId, addGlobalUser, addGlobalUsers, removeGlobalUser } = form;
  return (
    <>
      <SectionHeader
        title="Global Highlighted Users"
        blurb="These users will be highlighted in all rooms. Use Discord user IDs or Telegram @usernames."
      />

      <div className="space-y-comfy">
        <div className="flex gap-cozy">
          <input
            type="text"
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addGlobalUser()}
            placeholder="User ID or @telegram_username"
            className={cn(INPUT_CLASS, 'flex-1')}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
          />
          <button
            onClick={addGlobalUser}
            className="oct-btn-primary px-comfy py-snug text-sm"
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

        <div className="space-y-tight">
          {globalUsers.length === 0 && (
            <EmptyNote>No global highlighted users.</EmptyNote>
          )}
          {globalUsers.map((uid) => {
            const isTgUser = uid.startsWith('@');
            return (
              <FieldRow key={uid} className="flex items-center justify-between gap-cozy py-snug oct-row-hover">
                <div className="flex items-center gap-cozy min-w-0">
                  {isTgUser && <Send size={12} className="text-oct-accent shrink-0" />}
                  {/* IDs and handles are keys, so they take the data role. */}
                  <span className={cn('type-data truncate', isTgUser ? 'text-oct-accent' : 'text-oct-text')}>{uid}</span>
                  {!isTgUser && userNameMap.has(uid) && (
                    <span className="type-caption text-oct-muted shrink-0">{userNameMap.get(uid)}</span>
                  )}
                </div>
                <RemoveButton onClick={() => removeGlobalUser(uid)} title="Remove user">
                  <Trash2 size={14} />
                </RemoveButton>
              </FieldRow>
            );
          })}
        </div>
      </div>
    </>
  );
}
