import type { Dispatch, SetStateAction } from 'react';
import { Search, Trash2, Hash, MessageCircle, Users, Palette, Send } from 'lucide-react';
import type { ChannelRef, AppConfig, AuthStatus, GuildInfo, DMChannel, TelegramChatInfo } from '../../types';
import type { AppState } from '../../stores/appStore';
import ColorPickerWithAlpha from '../ColorPickerWithAlpha';

interface ChannelsTabProps {
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  roomColor: string;
  setRoomColor: Dispatch<SetStateAction<string>>;
  hotkey: string;
  setHotkey: Dispatch<SetStateAction<string>>;
  selectedChannels: ChannelRef[];
  toggleChannel: (ref: ChannelRef) => void;
  toggleChannelEmbeds: (channelId: string) => void;
  isChannelSelected: (channelId: string) => boolean;
  config: AppConfig | null;
  updateConfig: AppState['updateConfig'];
  guilds: GuildInfo[];
  dmChannels: DMChannel[];
  telegramChats: TelegramChatInfo[];
  authStatus: AuthStatus | null;
  platformTab: 'discord' | 'telegram';
  setPlatformTab: Dispatch<SetStateAction<'discord' | 'telegram'>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  filteredGuilds: GuildInfo[];
  filteredDMs: DMChannel[];
  filteredTelegramChats: TelegramChatInfo[];
}

export default function ChannelsTab({
  name,
  setName,
  roomColor,
  setRoomColor,
  hotkey,
  setHotkey,
  selectedChannels,
  toggleChannel,
  toggleChannelEmbeds,
  isChannelSelected,
  config,
  updateConfig,
  guilds,
  dmChannels,
  telegramChats,
  authStatus,
  platformTab,
  setPlatformTab,
  search,
  setSearch,
  filteredGuilds,
  filteredDMs,
  filteredTelegramChats,
}: ChannelsTabProps) {
  return (
            <>
              {/* Room name */}
              <div className="mb-4">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-2">
                  Room Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-room"
                  className="w-full bg-discord-dark border-none rounded px-3 py-2 text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple"
                />
              </div>

              {/* Room background color */}
              <div className="mb-4">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-2">
                  Room Background Color
                </label>
                <div className="flex items-center gap-3">
                  <ColorPickerWithAlpha
                    value={roomColor || '#0B0E1A'}
                    onChange={(c) => setRoomColor(c)}
                    defaultColor="#0B0E1A"
                    size="md"
                    showTextInput
                  />
                  {roomColor && (
                    <button
                      onClick={() => setRoomColor('')}
                      className="text-[11px] text-discord-text-muted hover:text-white"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>

              {/* Hotkey */}
              <div className="mb-4">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-2">
                  Hotkey
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    readOnly
                    value={hotkey ? hotkey.toUpperCase() : ''}
                    onKeyDown={(e) => {
                      e.preventDefault();
                      if (['Backspace', 'Delete', 'Escape'].includes(e.key)) { setHotkey(''); return; }
                      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) setHotkey(e.key.toLowerCase());
                    }}
                    placeholder="Press a key"
                    className="w-24 bg-discord-dark border-none rounded px-3 py-2 text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple text-center cursor-pointer caret-transparent"
                  />
                  {hotkey && (
                    <button
                      onClick={() => setHotkey('')}
                      className="text-[11px] text-discord-text-muted hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-discord-text-muted mt-1.5">
                  Press this key anywhere (outside a text field) to jump to this room.
                </p>
              </div>

              {/* Selected count */}
              <div className="text-[11px] text-discord-text-muted mb-3">
                {selectedChannels.length} channel{selectedChannels.length !== 1 ? 's' : ''} selected
              </div>

              {/* Per-channel embed settings */}
              {selectedChannels.length > 0 && (
                <div className="mb-4 border border-discord-divider rounded p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-2">
                    Embeds per channel
                  </div>
                  <div className="space-y-1.5">
                    {selectedChannels.map((ch) => (
                      <div key={ch.channelId} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-discord-dark/50">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {ch.source === 'telegram'
                            ? <Send size={12} className="shrink-0 text-[#2AABEE]" />
                            : ch.guildId
                              ? <Hash size={12} className="shrink-0 text-discord-channel-icon" />
                              : <MessageCircle size={12} className="shrink-0 text-discord-channel-icon" />
                          }
                          <span className="text-sm text-discord-text truncate">
                            {ch.guildName ? `${ch.guildName} / ` : ''}{ch.channelName ?? ch.channelId}
                          </span>
                        </div>
                        <button
                          onClick={() => toggleChannelEmbeds(ch.channelId)}
                          className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded transition-colors ${
                            ch.disableEmbeds
                              ? 'bg-discord-red/20 text-discord-red'
                              : 'bg-discord-green/20 text-discord-green'
                          }`}
                        >
                          {ch.disableEmbeds ? 'EMBEDS OFF' : 'EMBEDS ON'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Guild message colors */}
              {(() => {
                const roomGuildIds = [...new Set(selectedChannels.map((c) => c.guildId).filter(Boolean))] as string[];
                if (roomGuildIds.length === 0) return null;
                const guildColors = config?.guildColors ?? {};
                return (
                  <div className="mb-4 border border-discord-divider rounded p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-2 flex items-center gap-1.5">
                      <Palette size={12} />
                      Guild Message Colors
                    </div>
                    <p className="text-xs text-discord-text-muted mb-2">
                      Color-code messages by server. Changes apply globally.
                    </p>
                    <div className="space-y-1.5">
                      {roomGuildIds.map((guildId) => {
                        const guildName = selectedChannels.find((c) => c.guildId === guildId)?.guildName
                          ?? guilds.find((g) => g.id === guildId)?.name
                          ?? guildId;
                        return (
                          <div key={guildId} className="flex items-center gap-2.5 px-2 py-1.5 rounded bg-discord-dark/50">
                            <ColorPickerWithAlpha
                              value={guildColors[guildId] || '#0B0E1A'}
                              onChange={(c) => updateConfig({ guildColors: { ...guildColors, [guildId]: c } })}
                              defaultColor="#0B0E1A"
                            />
                            <span className="text-sm text-discord-text flex-1 truncate">{guildName}</span>
                            {guildColors[guildId] && (
                              <button
                                onClick={() => {
                                  const { [guildId]: _, ...rest } = guildColors;
                                  updateConfig({ guildColors: rest });
                                }}
                                className="text-discord-text-muted hover:text-white shrink-0"
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* DM message colors */}
              {(() => {
                const roomDmChannelIds = selectedChannels.filter((c) => !c.guildId && c.source !== 'telegram').map((c) => c.channelId);
                if (roomDmChannelIds.length === 0) return null;
                const dmColors = config?.dmColors ?? {};
                return (
                  <div className="mb-4 border border-discord-divider rounded p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-2 flex items-center gap-1.5">
                      <Palette size={12} />
                      DM Message Colors
                    </div>
                    <p className="text-xs text-discord-text-muted mb-2">
                      Color-code messages by DM. Changes apply globally.
                    </p>
                    <div className="space-y-1.5">
                      {roomDmChannelIds.map((channelId) => {
                        const dm = dmChannels.find((d) => d.id === channelId);
                        const dmName = dm
                          ? dm.recipients.map((r) => r.global_name || r.username).join(', ')
                          : selectedChannels.find((c) => c.channelId === channelId)?.channelName ?? channelId;
                        return (
                          <div key={channelId} className="flex items-center gap-2.5 px-2 py-1.5 rounded bg-discord-dark/50">
                            <ColorPickerWithAlpha
                              value={dmColors[channelId] || '#0B0E1A'}
                              onChange={(c) => updateConfig({ dmColors: { ...dmColors, [channelId]: c } })}
                              defaultColor="#0B0E1A"
                            />
                            <span className="text-sm text-discord-text flex-1 truncate">{dmName}</span>
                            {dmColors[channelId] && (
                              <button
                                onClick={() => {
                                  const { [channelId]: _, ...rest } = dmColors;
                                  updateConfig({ dmColors: rest });
                                }}
                                className="text-discord-text-muted hover:text-white shrink-0"
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Telegram chat colors */}
              {(() => {
                const roomTgChannelIds = [...new Set(
                  selectedChannels.filter((c) => c.source === 'telegram').map((c) => c.channelId)
                )];
                if (roomTgChannelIds.length === 0) return null;
                const telegramColors = config?.telegramColors ?? {};
                return (
                  <div className="mb-4 border border-discord-divider rounded p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-2 flex items-center gap-1.5">
                      <Send size={12} className="text-[#2AABEE]" />
                      Telegram Chat Colors
                    </div>
                    <p className="text-xs text-discord-text-muted mb-2">
                      Color-code messages by Telegram chat. Changes apply globally.
                    </p>
                    <div className="space-y-1.5">
                      {roomTgChannelIds.map((channelId) => {
                        const chatName = selectedChannels.find((c) => c.channelId === channelId)?.channelName ?? channelId;
                        return (
                          <div key={channelId} className="flex items-center gap-2.5 px-2 py-1.5 rounded bg-discord-dark/50">
                            <ColorPickerWithAlpha
                              value={telegramColors[channelId] || '#0B0E1A'}
                              onChange={(c) => updateConfig({ telegramColors: { ...telegramColors, [channelId]: c } })}
                              defaultColor="#0B0E1A"
                            />
                            <span className="text-sm text-discord-text flex-1 truncate">{chatName}</span>
                            {telegramColors[channelId] && (
                              <button
                                onClick={() => {
                                  const { [channelId]: _, ...rest } = telegramColors;
                                  updateConfig({ telegramColors: rest });
                                }}
                                className="text-discord-text-muted hover:text-white shrink-0"
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Platform toggle */}
              {(authStatus?.telegramConnected || authStatus?.telegramConfigured || telegramChats.length > 0) && (
                <div className="flex rounded-lg bg-discord-dark p-0.5 mb-3">
                  <button
                    onClick={() => setPlatformTab('discord')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                      platformTab === 'discord'
                        ? 'bg-discord-blurple text-white'
                        : 'text-discord-text-muted hover:text-discord-text'
                    }`}
                  >
                    <Hash size={12} />
                    Discord
                  </button>
                  <button
                    onClick={() => setPlatformTab('telegram')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                      platformTab === 'telegram'
                        ? 'bg-[#2AABEE] text-white'
                        : 'text-discord-text-muted hover:text-discord-text'
                    }`}
                  >
                    <Send size={12} />
                    Telegram
                  </button>
                </div>
              )}

              {/* Search */}
              <div className="relative mb-4">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-discord-text-muted" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={platformTab === 'telegram' ? 'Search Telegram chats...' : 'Search Discord channels...'}
                  className="w-full bg-discord-dark border-none rounded px-3 py-2 pl-9 text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple"
                />
              </div>

              <div className="space-y-3 max-h-[300px] overflow-y-auto">
                {/* Discord section */}
                {platformTab === 'discord' && (
                  <>
                    {(filteredGuilds.length > 0 || filteredDMs.length > 0) ? (
                      <div className="space-y-3">
                        {filteredGuilds.map((guild) => (
                          <div key={guild.id}>
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-1 flex items-center gap-1.5">
                              <Users size={12} />
                              {guild.name}
                            </div>
                            <div className="space-y-0.5 ml-2">
                              {guild.channels.map((ch) => {
                                const selected = isChannelSelected(ch.id);
                                return (
                                  <button
                                    key={ch.id}
                                    onClick={() =>
                                      toggleChannel({
                                        guildId: guild.id,
                                        channelId: ch.id,
                                        guildName: guild.name,
                                        channelName: ch.name,
                                      })
                                    }
                                    className={`w-full flex items-center gap-2 px-2 py-1 rounded text-sm text-left transition-colors ${
                                      selected
                                        ? 'bg-discord-blurple/20 text-discord-blurple'
                                        : 'text-discord-channel-icon hover:bg-discord-hover/50 hover:text-discord-text'
                                    }`}
                                  >
                                    <Hash size={14} />
                                    <span className="truncate">{ch.name}</span>
                                    {selected && <span className="ml-auto text-[10px]">ADDED</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}

                        {filteredDMs.length > 0 && (
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-discord-text-muted mb-1 flex items-center gap-1.5">
                              <MessageCircle size={12} />
                              Direct Messages
                            </div>
                            <div className="space-y-0.5 ml-2">
                              {filteredDMs.map((dm) => {
                                const selected = isChannelSelected(dm.id);
                                const recipientNames = dm.recipients
                                  .map((r) => r.global_name || r.username)
                                  .join(', ');
                                return (
                                  <button
                                    key={dm.id}
                                    onClick={() =>
                                      toggleChannel({
                                        guildId: null,
                                        channelId: dm.id,
                                        channelName: recipientNames,
                                      })
                                    }
                                    className={`w-full flex items-center gap-2 px-2 py-1 rounded text-sm text-left transition-colors ${
                                      selected
                                        ? 'bg-discord-blurple/20 text-discord-blurple'
                                        : 'text-discord-channel-icon hover:bg-discord-hover/50 hover:text-discord-text'
                                    }`}
                                  >
                                    <MessageCircle size={14} />
                                    <span className="truncate">{recipientNames}</span>
                                    {selected && <span className="ml-auto text-[10px]">ADDED</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-discord-text-muted text-center py-4">
                        {guilds.length === 0 ? 'Loading Discord channels...' : 'No Discord channels match your search.'}
                      </p>
                    )}
                  </>
                )}

                {/* Telegram section */}
                {platformTab === 'telegram' && (
                  <>
                    {filteredTelegramChats.length > 0 ? (
                      <div className="space-y-0.5">
                        {filteredTelegramChats.map((chat) => {
                          const selected = isChannelSelected(chat.id);
                          const typeLabel = chat.type === 'channel' ? 'CH' : chat.type === 'supergroup' ? 'SG' : chat.type === 'group' ? 'GP' : '';
                          return (
                            <button
                              key={chat.id}
                              onClick={() =>
                                toggleChannel({
                                  source: 'telegram',
                                  guildId: null,
                                  channelId: chat.id,
                                  guildName: chat.type !== 'user' ? chat.title : undefined,
                                  channelName: chat.title,
                                })
                              }
                              className={`w-full flex items-center gap-2 px-2 py-1 rounded text-sm text-left transition-colors ${
                                selected
                                  ? 'bg-[#2AABEE]/20 text-[#2AABEE]'
                                  : 'text-discord-channel-icon hover:bg-discord-hover/50 hover:text-discord-text'
                              }`}
                            >
                              <Send size={14} />
                              <span className="truncate">{chat.title}</span>
                              {typeLabel && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-discord-dark/50 text-discord-text-muted shrink-0">{typeLabel}</span>
                              )}
                              {selected && <span className="ml-auto text-[10px]">ADDED</span>}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-discord-text-muted text-center py-4">
                        {telegramChats.length === 0 ? 'No Telegram chats available. Connect Telegram in Settings.' : 'No Telegram chats match your search.'}
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
  );
}
