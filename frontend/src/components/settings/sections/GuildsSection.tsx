import { Key, Search, Plus, Trash2, Eye, EyeOff, Volume2, Upload, Play, Users, Shield, Tag, Zap, Settings2, ArrowLeft, HelpCircle, Bell, PanelLeftOpen, Send, Download, AlertTriangle, AtSign } from 'lucide-react';
import type { SolPlatform, EvmPlatform, ContractClickAction, BadgeClickAction, KeywordPattern, KeywordMatchMode, SoundSettings, SoundType, SoundConfig, PushoverPriority, PushoverSound, PushoverTriggers, PushoverFilters, MessageDisplay, SplitLayout, MissedRunnerConfig, MissedRunnerNotifyVia, ToastPosition } from '../../../types';
import { PUSHOVER_SOUNDS, TOAST_POSITIONS, MISSED_RUNNER_NOTIFY_OPTIONS } from '../../../types';
import { requestNotificationPermission } from '../../../utils/desktopNotification';
import { previewSound, previewPreset, PRESET_SOUNDS } from '../../../utils/notificationSound';
import ColorPickerWithAlpha from '../../ColorPickerWithAlpha';
import TelegramSetup from '../../TelegramSetup';
import { isHostedMode } from '../../../lib/supabase';
import { isClientGatewayMode } from '../../../discord/clientGateway';
import { Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';
import { useMemo, useRef } from 'react';

export default function GuildsSection({ form }: { form: SettingsForm }) {
  const {
    config, updateConfig, guilds, rooms, dmChannels, fetchGuilds,
    fetchDMChannels, fetchConfig, maskedTokens, fetchMaskedTokens, addToken, removeToken,
    allMessages, navigate, settingsSection, sidebarCollapsed, toggleSidebar, authStatus,
    telegramDisconnect, fetchRooms, userNameMap, section, setSection, globalUsers,
    setGlobalUsers, newUserId, setNewUserId, contractDetection, setContractDetection, guildColors,
    setGuildColors, dmColors, setDmColors, telegramColors, setTelegramColors, enabledGuilds,
    setEnabledGuilds, guildSearch, setGuildSearch, evmAddressColor, setEvmAddressColor, solAddressColor,
    setSolAddressColor, openInDiscordApp, setOpenInDiscordApp, openInTelegramApp, setOpenInTelegramApp, messageSounds,
    setMessageSounds, soundSettings, setSoundSettings, channelSounds, setChannelSounds, uploadingSoundType,
    setUploadingSoundType, uploadingChannelId, setUploadingChannelId, fileInputRef, channelFileInputRef, pushoverEnabled,
    setPushoverEnabled, pushoverAppToken, setPushoverAppToken, pushoverUserKey, setPushoverUserKey, pushoverPriority,
    setPushoverPriority, pushoverSound, setPushoverSound, pushoverTriggers, setPushoverTriggers, pushoverFilters,
    setPushoverFilters, missedRunnerEnabled, setMissedRunnerEnabled, missedRunnerMultiplier, setMissedRunnerMultiplier, missedRunnerLookbackHours,
    setMissedRunnerLookbackHours, missedRunnerCooldownHours, setMissedRunnerCooldownHours, missedRunnerMinMcAtCall, setMissedRunnerMinMcAtCall, missedRunnerNotifyVia,
    setMissedRunnerNotifyVia, missedRunnerTestAddress, setMissedRunnerTestAddress, missedRunnerTestForce, setMissedRunnerTestForce, missedRunnerTestLoading,
    setMissedRunnerTestLoading, missedRunnerTestResult, setMissedRunnerTestResult, solPlatform, setSolPlatform, evmPlatform,
    setEvmPlatform, customSolUrl, setCustomSolUrl, customEvmUrl, setCustomEvmUrl, contractClickAction,
    setContractClickAction, showFullContractAddress, setShowFullContractAddress, autoOpenHighlightedContracts, setAutoOpenHighlightedContracts, signalConvergenceWindowMinutes,
    setSignalConvergenceWindowMinutes, globalKeywordPatterns, setGlobalKeywordPatterns, keywordAlertsEnabled, setKeywordAlertsEnabled, desktopNotifications,
    setDesktopNotifications, toastAlertsEnabled, setToastAlertsEnabled, toastPosition, setToastPosition, mentionsUserEnabled,
    setMentionsUserEnabled, mentionsRoleEnabled, setMentionsRoleEnabled, mentionsHereEnabled, setMentionsHereEnabled, mentionsEveryoneEnabled,
    setMentionsEveryoneEnabled, badgeClickAction, setBadgeClickAction, chattingEnabled, setChattingEnabled, messageDisplay,
    setMessageDisplay, compactModeAvatars, setCompactModeAvatars, roleColors, setRoleColors, mobileZoomScale,
    setMobileZoomScale, splitLayout, setSplitLayout, newKeywordPattern, setNewKeywordPattern, newKeywordMatchMode,
    setNewKeywordMatchMode, newKeywordLabel, setNewKeywordLabel, saving, setSaving, newToken,
    setNewToken, showNewToken, setShowNewToken, tokenError, setTokenError, addingToken,
    setAddingToken, proxyUrl, setProxyUrl, proxySaving, setProxySaving, proxySaved,
    setProxySaved, saveError, setSaveError, showTelegramSetup, setShowTelegramSetup, exporting,
    setExporting, importing, setImporting, importError, setImportError, importSuccess,
    setImportSuccess, importFileRef, hasUnsavedChanges, guardNavigation, handleSave, handleMissedRunnerTest,
    handleExport, handleImportFile, addGlobalUser, removeGlobalUser, addKeyword,
  } = form;

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
  return (
              <>
                <div>
                  <h3 className="font-display text-3xl sm:text-4xl tracking-tight text-oct-text mb-4">Guilds</h3>

                  <div className="space-y-5">
                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Enabled Guilds ]</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
                        Only enabled guilds will appear in the channel picker when creating rooms. All guilds are off by default.
                      </p>
                      <div className="relative mb-3">
                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-oct-muted" />
                        <input
                          type="text"
                          value={guildSearch}
                          onChange={(e) => setGuildSearch(e.target.value)}
                          placeholder="Search guilds..."
                          className="w-full px-3 py-2 pl-9 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent"
                        />
                      </div>
                      <div className="text-[11px] font-mono uppercase tracking-wide text-oct-muted mb-2">
                        {enabledGuilds.length} of {guilds.length} guilds enabled
                      </div>
                      <div className="space-y-1 max-h-[350px] overflow-y-auto">
                        {guilds
                          .filter((g) => !guildSearch || g.name.toLowerCase().includes(guildSearch.toLowerCase()))
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
                                className={`w-full flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 rounded-cockpit border-2 text-xs sm:text-sm text-left transition-colors duration-100 ${
                                  enabled
                                    ? 'border-oct-green bg-oct-green/15 text-oct-text'
                                    : 'border-oct-border bg-oct-bg text-oct-muted'
                                }`}
                              >
                                <div
                                  className={`w-4 h-4 rounded-cockpit border-2 flex items-center justify-center shrink-0 transition-colors duration-100 ${
                                    enabled
                                      ? 'bg-oct-green border-oct-green'
                                      : 'border-oct-border-bright bg-transparent'
                                  }`}
                                >
                                  {enabled && (
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                                      <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  )}
                                </div>
                                <Users size={14} className="shrink-0 opacity-60" />
                                <span className="truncate flex-1">{guild.name}</span>
                                <span className="text-[11px] font-mono text-oct-muted shrink-0">
                                  {guild.channels.length} ch
                                </span>
                              </button>
                            );
                          })}
                        {guilds.length === 0 && (
                          <p className="text-sm text-oct-muted text-center py-2">Loading guilds...</p>
                        )}
                        {guilds.length > 0 && guilds.filter((g) => !guildSearch || g.name.toLowerCase().includes(guildSearch.toLowerCase())).length === 0 && (
                          <p className="text-sm text-oct-muted text-center py-2">No guilds match your search.</p>
                        )}
                      </div>
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Guild Message Colors ]</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
                        Set a background color for messages from each enabled guild to visually distinguish them in mixed rooms.
                      </p>
                      <div className="space-y-2">
                        {guilds.filter((g) => enabledGuilds.includes(g.id)).map((guild) => (
                          <div key={guild.id} className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised">
                            <ColorPickerWithAlpha
                              value={guildColors[guild.id] || '#0B0E1A'}
                              onChange={(c) => setGuildColors((prev) => ({ ...prev, [guild.id]: c }))}
                              defaultColor="#0B0E1A"
                            />
                            <span className="text-xs sm:text-sm text-oct-text flex-1 truncate">{guild.name}</span>
                            {guildColors[guild.id] && (
                              <button
                                onClick={() => setGuildColors((prev) => { const { [guild.id]: _, ...rest } = prev; return rest; })}
                                className="text-oct-muted hover:text-oct-flame transition-colors duration-100"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        ))}
                        {enabledGuilds.length === 0 && (
                          <p className="text-sm text-oct-muted text-center py-2">Enable some guilds above first.</p>
                        )}
                      </div>
                    </div>

                    {(() => {
                      const dmChannelIdsInRooms = [...new Set(
                        rooms.flatMap((r) => r.channels.filter((c) => !c.guildId).map((c) => c.channelId))
                      )];
                      if (dmChannelIdsInRooms.length === 0) return null;
                      return (
                        <div className="brutal-card p-3 sm:p-4">
                          <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ DM Message Colors ]</h4>
                          <p className="text-xs sm:text-sm text-oct-muted mb-3">
                            Set a background color for messages from each DM that is added to a room.
                          </p>
                          <div className="space-y-2">
                            {dmChannelIdsInRooms.map((channelId) => {
                              const dm = dmChannels.find((d) => d.id === channelId);
                              const dmName = dm
                                ? dm.recipients.map((r) => r.global_name || r.username).join(', ')
                                : channelId;
                              return (
                                <div key={channelId} className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised">
                                  <ColorPickerWithAlpha
                                    value={dmColors[channelId] || '#0B0E1A'}
                                    onChange={(c) => setDmColors((prev) => ({ ...prev, [channelId]: c }))}
                                    defaultColor="#0B0E1A"
                                  />
                                  <span className="text-xs sm:text-sm text-oct-text flex-1 truncate">{dmName}</span>
                                  {dmColors[channelId] && (
                                    <button
                                      onClick={() => setDmColors((prev) => { const { [channelId]: _, ...rest } = prev; return rest; })}
                                      className="text-oct-muted hover:text-oct-flame transition-colors duration-100"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {(() => {
                      const tgChannelIdsInRooms = [...new Set(
                        rooms.flatMap((r) => r.channels.filter((c) => c.source === 'telegram').map((c) => c.channelId))
                      )];
                      if (tgChannelIdsInRooms.length === 0) return null;
                      return (
                        <div className="brutal-card p-3 sm:p-4">
                          <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2 flex items-center gap-1.5">
                            <Send size={14} className="text-oct-accent" />
                            [ Telegram Chat Colors ]
                          </h4>
                          <p className="text-xs sm:text-sm text-oct-muted mb-3">
                            Set a background color for messages from each Telegram chat that is added to a room.
                          </p>
                          <div className="space-y-2">
                            {tgChannelIdsInRooms.map((channelId) => {
                              const channelRef = rooms.flatMap((r) => r.channels).find((c) => c.channelId === channelId && c.source === 'telegram');
                              const chatName = channelRef?.channelName ?? channelId;
                              return (
                                <div key={channelId} className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised">
                                  <ColorPickerWithAlpha
                                    value={telegramColors[channelId] || '#0B0E1A'}
                                    onChange={(c) => setTelegramColors((prev) => ({ ...prev, [channelId]: c }))}
                                    defaultColor="#0B0E1A"
                                  />
                                  <span className="text-xs sm:text-sm text-oct-text flex-1 truncate">{chatName}</span>
                                  {telegramColors[channelId] && (
                                    <button
                                      onClick={() => setTelegramColors((prev) => { const { [channelId]: _, ...rest } = prev; return rest; })}
                                      className="text-oct-muted hover:text-oct-flame transition-colors duration-100"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </>
  );
}
