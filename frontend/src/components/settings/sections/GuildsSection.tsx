import { Search, Trash2, Users, Send } from 'lucide-react';
import ColorPickerWithAlpha from '../../ColorPickerWithAlpha';
import type { SettingsForm } from '../useSettingsForm';
import { useMemo, useRef } from 'react';
import { cn } from '../../../lib/utils';
import {
  FieldRow,
  INPUT_CLASS,
  Kicker,
  RemoveButton,
  SectionHeader,
  SectionStack,
  SettingsCard,
} from '../fields';

const DEFAULT_ROW_COLOR = '#0B0E1A';

/** One colour-picker row: swatch, name, and a remove button once a colour is set. */
function ColorRow({
  name,
  value,
  onChange,
  onClear,
}: {
  name: string;
  value: string | undefined;
  onChange: (c: string) => void;
  onClear: () => void;
}) {
  return (
    <FieldRow className="flex items-center gap-comfy py-snug">
      <ColorPickerWithAlpha value={value || DEFAULT_ROW_COLOR} onChange={onChange} defaultColor={DEFAULT_ROW_COLOR} />
      <span className="type-body text-oct-text flex-1 truncate">{name}</span>
      {value && (
        <RemoveButton onClick={onClear} title="Clear colour">
          <Trash2 size={14} />
        </RemoveButton>
      )}
    </FieldRow>
  );
}

export default function GuildsSection({ form }: { form: SettingsForm }) {
  const { config, guilds, rooms, dmChannels, guildColors, setGuildColors, dmColors, setDmColors, telegramColors, setTelegramColors, enabledGuilds, setEnabledGuilds, guildSearch, setGuildSearch } = form;

  // Snapshot of which guilds were enabled when this section mounted. The guild
  // list sorts by THIS, not by the live `enabledGuilds`, so rows keep their
  // position while you tick several in a row. Without it the list re-sorts on
  // every toggle and clicks land on the wrong guild.
  const initialEnabledRef = useRef<string[] | null>(null);
  if (initialEnabledRef.current === null && config) {
    initialEnabledRef.current = config.enabledGuilds ?? [];
  }
  const initialEnabledGuilds = useMemo(
    () => new Set(initialEnabledRef.current ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialEnabledRef.current],
  );

  const visibleGuilds = guilds.filter((g) => !guildSearch || g.name.toLowerCase().includes(guildSearch.toLowerCase()));

  return (
    <>
      <SectionHeader title="Guilds" />

      <SectionStack>
        <SettingsCard
          title="Enabled Guilds"
          blurb="Only enabled guilds will appear in the channel picker when creating rooms. All guilds are off by default."
        >
          <div className="relative mb-cozy">
            <Search size={15} className="absolute left-comfy top-1/2 -translate-y-1/2 text-oct-muted" />
            <input
              type="text"
              value={guildSearch}
              onChange={(e) => setGuildSearch(e.target.value)}
              placeholder="Search guilds..."
              className={cn(INPUT_CLASS, 'pl-9')}
            />
          </div>
          <Kicker className="mb-cozy">
            <span className="type-data text-2xs">{enabledGuilds.length}</span> of <span className="type-data text-2xs">{guilds.length}</span> guilds enabled
          </Kicker>
          <div className="space-y-tight max-h-[350px] overflow-y-auto">
            {visibleGuilds
              // Sort by the order captured when the list was opened, NOT by
              // live `enabledGuilds`. Sorting on the live value re-ordered the
              // list on every toggle: the guild you just enabled jumped to the
              // top, the rows shifted under the cursor, and the next click
              // landed on the wrong guild — so nothing changed and Save stayed
              // disabled, which reads as "it won't let me save".
              .sort((a, b) => {
                const aEnabled = initialEnabledGuilds.has(a.id) ? 0 : 1;
                const bEnabled = initialEnabledGuilds.has(b.id) ? 0 : 1;
                if (aEnabled !== bEnabled) return aEnabled - bEnabled;
                return a.name.localeCompare(b.name);
              })
              .map((guild) => {
                const enabled = enabledGuilds.includes(guild.id);
                return (
                  <button
                    key={guild.id}
                    onClick={() => {
                      setEnabledGuilds((prev) =>
                        enabled ? prev.filter((id) => id !== guild.id) : [...prev, guild.id]
                      );
                    }}
                    // Enabled is a state, not a brand, so it reads in `oct-good`.
                    className={cn(
                      'w-full flex items-center gap-cozy px-comfy py-snug rounded-oct border type-body text-left transition-colors duration-150',
                      enabled
                        ? 'border-oct-good/60 bg-oct-good-dim text-oct-text'
                        : 'border-oct-border bg-oct-surface-raised/40 text-oct-muted hover:border-oct-border-bright',
                    )}
                  >
                    <div
                      className={cn(
                        'w-4 h-4 rounded-oct-sm border flex items-center justify-center shrink-0 transition-colors duration-100',
                        enabled ? 'bg-oct-good border-oct-good' : 'border-oct-border-bright bg-transparent',
                      )}
                    >
                      {enabled && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                    <Users size={14} className="shrink-0 opacity-60" />
                    <span className="truncate flex-1">{guild.name}</span>
                    <span className="type-data text-2xs text-oct-muted shrink-0">
                      {guild.channels.length} ch
                    </span>
                  </button>
                );
              })}
            {guilds.length === 0 && (
              <p className="type-body text-oct-muted text-center py-cozy">Loading guilds...</p>
            )}
            {guilds.length > 0 && visibleGuilds.length === 0 && (
              <p className="type-body text-oct-muted text-center py-cozy">No guilds match your search.</p>
            )}
          </div>
        </SettingsCard>

        <SettingsCard
          title="Guild Message Colors"
          blurb="Set a background color for messages from each enabled guild to visually distinguish them in mixed rooms."
        >
          <div className="space-y-tight">
            {guilds.filter((g) => enabledGuilds.includes(g.id)).map((guild) => (
              <ColorRow
                key={guild.id}
                name={guild.name}
                value={guildColors[guild.id]}
                onChange={(c) => setGuildColors((prev) => ({ ...prev, [guild.id]: c }))}
                onClear={() => setGuildColors((prev) => { const { [guild.id]: _, ...rest } = prev; return rest; })}
              />
            ))}
            {enabledGuilds.length === 0 && (
              <p className="type-body text-oct-muted text-center py-cozy">Enable some guilds above first.</p>
            )}
          </div>
        </SettingsCard>

        {(() => {
          const dmChannelIdsInRooms = [...new Set(
            rooms.flatMap((r) => r.channels.filter((c) => !c.guildId).map((c) => c.channelId))
          )];
          if (dmChannelIdsInRooms.length === 0) return null;
          return (
            <SettingsCard
              title="DM Message Colors"
              blurb="Set a background color for messages from each DM that is added to a room."
            >
              <div className="space-y-tight">
                {dmChannelIdsInRooms.map((channelId) => {
                  const dm = dmChannels.find((d) => d.id === channelId);
                  const dmName = dm
                    ? dm.recipients.map((r) => r.global_name || r.username).join(', ')
                    : channelId;
                  return (
                    <ColorRow
                      key={channelId}
                      name={dmName}
                      value={dmColors[channelId]}
                      onChange={(c) => setDmColors((prev) => ({ ...prev, [channelId]: c }))}
                      onClear={() => setDmColors((prev) => { const { [channelId]: _, ...rest } = prev; return rest; })}
                    />
                  );
                })}
              </div>
            </SettingsCard>
          );
        })()}

        {(() => {
          const tgChannelIdsInRooms = [...new Set(
            rooms.flatMap((r) => r.channels.filter((c) => c.source === 'telegram').map((c) => c.channelId))
          )];
          if (tgChannelIdsInRooms.length === 0) return null;
          return (
            <SettingsCard
              icon={<Send size={14} className="text-oct-telegram" />}
              title="Telegram Chat Colors"
              blurb="Set a background color for messages from each Telegram chat that is added to a room."
            >
              <div className="space-y-tight">
                {tgChannelIdsInRooms.map((channelId) => {
                  const channelRef = rooms.flatMap((r) => r.channels).find((c) => c.channelId === channelId && c.source === 'telegram');
                  const chatName = channelRef?.channelName ?? channelId;
                  return (
                    <ColorRow
                      key={channelId}
                      name={chatName}
                      value={telegramColors[channelId]}
                      onChange={(c) => setTelegramColors((prev) => ({ ...prev, [channelId]: c }))}
                      onClear={() => setTelegramColors((prev) => { const { [channelId]: _, ...rest } = prev; return rest; })}
                    />
                  );
                })}
              </div>
            </SettingsCard>
          );
        })()}
      </SectionStack>
    </>
  );
}
