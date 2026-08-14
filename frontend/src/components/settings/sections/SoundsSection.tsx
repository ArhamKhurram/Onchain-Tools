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

export default function SoundsSection({ form }: { form: SettingsForm }) {
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
  return (
              <>
                <div>
                  <h3 className="font-display text-2xl sm:text-3xl tracking-tight text-oct-text mb-4">Sounds & Notifications</h3>

                  <div className="space-y-5">
                    <div className="oct-card p-4 sm:p-5">
                      <h4 className="oct-eyebrow mb-2">On-site toast alerts</h4>
                      <Toggle
                        value={toastAlertsEnabled}
                        onChange={setToastAlertsEnabled}
                        label="Show in-app toast popups for highlighted users, contracts, keywords, convergence, FOMO trades, and pump callouts"
                      />
                      {toastAlertsEnabled && (
                        <div className="mt-3">
                          <label className="block text-xs font-medium text-oct-muted mb-2 uppercase tracking-wide">Toast position</label>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {TOAST_POSITIONS.map(({ value, label }) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => setToastPosition(value)}
                                className={`px-2 py-1.5 rounded-oct-sm font-mono text-xs border transition-all duration-150 ${
                                  toastPosition === value
                                    ? 'bg-oct-accent text-white border-oct-accent/50 shadow-oct-glow-accent'
                                    : 'bg-oct-surface-raised/40 text-oct-muted border-oct-border hover:text-oct-text hover:border-oct-border-bright'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="oct-card p-4 sm:p-5">
                      <h4 className="oct-eyebrow mb-2">Desktop Notifications</h4>
                      <Toggle
                        value={desktopNotifications}
                        onChange={async (v) => {
                          if (v) {
                            const perm = await requestNotificationPermission();
                            if (perm === 'denied') {
                              alert('Notification permission was denied. Please allow notifications for this site in your browser settings, then try again.');
                              return;
                            }
                          }
                          setDesktopNotifications(v);
                        }}
                        label="Show browser notifications for highlighted users and keyword matches (when tab is not focused)"
                      />
                    </div>

                    <div className="oct-card p-4 sm:p-5">
                      <h4 className="oct-eyebrow mb-3">Sound Settings</h4>
                      <Toggle
                        value={messageSounds}
                        onChange={setMessageSounds}
                        label="Enable notification sounds (master toggle)"
                      />

                      {messageSounds && (
                        <div className="space-y-3 mt-4">
                          <input
                            type="file"
                            ref={fileInputRef}
                            accept=".mp3,.wav,.ogg,.webm,.m4a"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file || !uploadingSoundType) return;
                              const formData = new FormData();
                              formData.append('file', file);
                              try {
                                const res = await fetch(`/api/sounds/${uploadingSoundType}`, { method: 'POST', body: formData });
                                const data = await res.json();
                                if (res.ok && data.url) {
                                  setSoundSettings((prev) => ({
                                    ...prev,
                                    [uploadingSoundType]: { ...prev[uploadingSoundType], useCustom: true, customSoundUrl: data.url },
                                  }));
                                }
                              } catch { /* ignore */ }
                              setUploadingSoundType(null);
                              e.target.value = '';
                            }}
                          />
                          {([
                            ['highlight', 'Highlighted User'],
                            ['contractAlert', 'Contract Alert'],
                            ['keywordAlert', 'Keyword Match'],
                            ['fomoTrade', 'FOMO Trade'],
                            ['pumpCallout', 'Pump Callout'],
                            ['revival', 'Revival'],
                            ['breakout', 'Breakout'],
                          ] as [SoundType, string][]).map(([type, label]) => {
                            const sc = soundSettings[type];
                            return (
                              <div key={type} className="rounded-oct border border-oct-border bg-oct-surface-raised px-2 sm:px-3 py-2.5 sm:py-3 space-y-2.5">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5 sm:gap-2">
                                    <Volume2 size={14} className="text-oct-muted shrink-0" />
                                    <span className="text-xs sm:text-sm text-oct-text font-medium">{label}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => previewSound(type, sc)}
                                      className="p-1 rounded-oct-sm text-oct-muted hover:text-oct-accent hover:bg-oct-surface transition-colors duration-100"
                                      title="Preview sound"
                                    >
                                      <Play size={14} />
                                    </button>
                                    <div
                                      className={`w-9 h-[18px] rounded-full transition-colors duration-100 relative cursor-pointer ${
                                        sc.enabled ? 'bg-oct-green' : 'bg-oct-border-bright'
                                      }`}
                                      onClick={() => setSoundSettings((prev) => ({
                                        ...prev,
                                        [type]: { ...prev[type], enabled: !prev[type].enabled },
                                      }))}
                                    >
                                      <div
                                        className={`absolute top-[2px] w-[14px] h-[14px] bg-oct-text rounded-full transition-transform duration-100 ${
                                          sc.enabled ? 'translate-x-[18px]' : 'translate-x-[2px]'
                                        }`}
                                      />
                                    </div>
                                  </div>
                                </div>

                                {sc.enabled && (
                                  <>
                                    <div className="flex items-center gap-3">
                                      <span className="font-mono text-[11px] text-oct-muted w-12 shrink-0 uppercase tracking-wide">Volume</span>
                                      <input
                                        type="range"
                                        min={0}
                                        max={100}
                                        value={sc.volume}
                                        onChange={(e) => setSoundSettings((prev) => ({
                                          ...prev,
                                          [type]: { ...prev[type], volume: Number(e.target.value) },
                                        }))}
                                        className="flex-1 h-1.5 accent-oct-accent cursor-pointer"
                                      />
                                      <span className="font-mono text-[11px] text-oct-muted w-8 text-right">{sc.volume}%</span>
                                    </div>

                                    {type === 'revival' && (
                                      <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs text-oct-muted">
                                          Repeat every ~5s until the revival banner is dismissed
                                        </span>
                                        <div
                                          className={`w-9 h-[18px] rounded-full transition-colors duration-100 relative cursor-pointer shrink-0 ${
                                            sc.repeatUntilDismissed !== false ? 'bg-oct-green' : 'bg-oct-border-bright'
                                          }`}
                                          onClick={() => setSoundSettings((prev) => ({
                                            ...prev,
                                            revival: { ...prev.revival, repeatUntilDismissed: !(prev.revival.repeatUntilDismissed !== false) },
                                          }))}
                                        >
                                          <div
                                            className={`absolute top-[2px] w-[14px] h-[14px] bg-oct-text rounded-full transition-transform duration-100 ${
                                              sc.repeatUntilDismissed !== false ? 'translate-x-[18px]' : 'translate-x-[2px]'
                                            }`}
                                          />
                                        </div>
                                      </div>
                                    )}

                                    <div className="space-y-2">
                                      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                                        <span className="font-mono text-[11px] text-oct-muted uppercase tracking-wide">Sound:</span>
                                        <button
                                          onClick={() => setSoundSettings((prev) => ({
                                            ...prev,
                                            [type]: { ...prev[type], useCustom: false, presetSound: undefined },
                                          }))}
                                          className={`px-2 py-1 rounded-oct-sm border font-mono text-[11px] font-bold uppercase tracking-wide transition-colors duration-100 ${
                                            !sc.useCustom && !sc.presetSound
                                              ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent'
                                              : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'
                                          }`}
                                        >
                                          Default
                                        </button>
                                        <button
                                          onClick={() => setSoundSettings((prev) => ({
                                            ...prev,
                                            [type]: { ...prev[type], useCustom: false, presetSound: prev[type].presetSound || 'ping' },
                                          }))}
                                          className={`px-2 py-1 rounded-oct-sm border font-mono text-[11px] font-bold uppercase tracking-wide transition-colors duration-100 ${
                                            !sc.useCustom && sc.presetSound
                                              ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent'
                                              : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'
                                          }`}
                                        >
                                          Preset
                                        </button>
                                        <button
                                          onClick={() => {
                                            if (sc.customSoundUrl) {
                                              setSoundSettings((prev) => ({ ...prev, [type]: { ...prev[type], useCustom: true, presetSound: undefined } }));
                                            } else {
                                              setUploadingSoundType(type);
                                              fileInputRef.current?.click();
                                            }
                                          }}
                                          className={`px-2 py-1 rounded-oct-sm border font-mono text-[11px] font-bold uppercase tracking-wide transition-colors duration-100 ${
                                            sc.useCustom
                                              ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent'
                                              : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'
                                          }`}
                                        >
                                          Custom
                                        </button>
                                      </div>
                                      {!sc.useCustom && sc.presetSound && (
                                        <div className="flex flex-wrap gap-1.5">
                                          {PRESET_SOUNDS.map((preset) => (
                                            <button
                                              key={preset.id}
                                              onClick={() => {
                                                setSoundSettings((prev) => ({ ...prev, [type]: { ...prev[type], presetSound: preset.id } }));
                                                previewPreset(preset.id, sc.volume);
                                              }}
                                              className={`px-2 py-1 rounded-oct-sm border font-mono text-[11px] transition-colors duration-100 ${sc.presetSound === preset.id ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent' : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'}`}
                                            >
                                              {preset.label}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                      {sc.useCustom && (
                                        <div className="flex items-center gap-2">
                                          {sc.customSoundUrl && (
                                            <span className="font-mono text-[11px] text-oct-muted truncate">{sc.customSoundUrl.split('/').pop()}</span>
                                          )}
                                          <button
                                            onClick={() => { setUploadingSoundType(type); fileInputRef.current?.click(); }}
                                            className="p-1 rounded-oct-sm text-oct-muted hover:text-oct-accent hover:bg-oct-surface transition-colors duration-100"
                                            title="Upload sound"
                                          >
                                            <Upload size={12} />
                                          </button>
                                          {sc.customSoundUrl && (
                                            <button
                                              onClick={async () => {
                                                await fetch(`/api/sounds/${type}`, { method: 'DELETE' });
                                                setSoundSettings((prev) => ({
                                                  ...prev,
                                                  [type]: { ...prev[type], useCustom: false, customSoundUrl: undefined },
                                                }));
                                              }}
                                              className="text-oct-muted hover:text-oct-flame transition-colors duration-100"
                                              title="Remove custom sound"
                                            >
                                              <Trash2 size={12} />
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="oct-card p-4 sm:p-5">
                      <h4 className="oct-eyebrow mb-2">Channel Sounds</h4>
                      <p className="text-xs text-oct-muted mb-3">
                        Play a notification sound for every message in specific channels, even when no highlight or keyword matches.
                      </p>
                      <input
                        type="file"
                        ref={channelFileInputRef}
                        accept=".mp3,.wav,.ogg,.webm,.m4a"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file || !uploadingChannelId) return;
                          const formData = new FormData();
                          formData.append('file', file);
                          try {
                            const res = await fetch(`/api/channel-sounds/${uploadingChannelId}`, { method: 'POST', body: formData });
                            const data = await res.json();
                            if (res.ok && data.url) {
                              setChannelSounds((prev) => ({
                                ...prev,
                                [uploadingChannelId]: { ...(prev[uploadingChannelId] ?? { enabled: true, volume: 80, useCustom: false }), useCustom: true, customSoundUrl: data.url },
                              }));
                            }
                          } catch { /* ignore */ }
                          setUploadingChannelId(null);
                          e.target.value = '';
                        }}
                      />
                      {(() => {
                        const rooms = config?.rooms ?? [];
                        const seen = new Set<string>();
                        const channels: { id: string; name: string; guildName: string | null; source: 'discord' | 'telegram' }[] = [];
                        for (const room of rooms) {
                          for (const ch of room.channels) {
                            if (!seen.has(ch.channelId)) {
                              seen.add(ch.channelId);
                              channels.push({ id: ch.channelId, name: ch.channelName ?? ch.channelId, guildName: ch.guildName ?? null, source: (ch.source ?? 'discord') as 'discord' | 'telegram' });
                            }
                          }
                        }
                        if (channels.length === 0) return <p className="text-xs text-oct-muted italic">No channels in rooms yet</p>;

                        const discordChannels = channels.filter((c) => c.source !== 'telegram');
                        const telegramChannels = channels.filter((c) => c.source === 'telegram');

                        const discordGrouped = new Map<string, typeof channels>();
                        for (const ch of discordChannels) {
                          const key = ch.guildName ?? 'DMs';
                          if (!discordGrouped.has(key)) discordGrouped.set(key, []);
                          discordGrouped.get(key)!.push(ch);
                        }

                        const enabledIds = Object.keys(channelSounds);

                        return (
                          <div className="space-y-3">
                            {/* Channel picker */}
                            <div className="space-y-2">
                              {Array.from(discordGrouped.entries()).map(([guildName, guildChannels]) => (
                                <div key={guildName}>
                                  <p className="font-mono text-[11px] text-oct-muted uppercase tracking-wider mb-1">{guildName}</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {guildChannels.map((ch) => {
                                      const active = ch.id in channelSounds;
                                      return (
                                        <button
                                          key={ch.id}
                                          onClick={() => {
                                            if (active) {
                                              setChannelSounds((prev) => {
                                                const next = { ...prev };
                                                delete next[ch.id];
                                                return next;
                                              });
                                            } else {
                                              setChannelSounds((prev) => ({
                                                ...prev,
                                                [ch.id]: { enabled: true, volume: 80, useCustom: false },
                                              }));
                                            }
                                          }}
                                          className={`px-2 py-1 rounded-oct-sm border font-mono text-xs transition-colors duration-100 ${active ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent' : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'}`}
                                        >
                                          #{ch.name}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}

                              {telegramChannels.length > 0 && (
                                <div>
                                  <p className="font-mono text-[11px] text-oct-accent uppercase tracking-wider mb-1 flex items-center gap-1">
                                    <Send size={9} />
                                    Telegram
                                  </p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {telegramChannels.map((ch) => {
                                      const active = ch.id in channelSounds;
                                      return (
                                        <button
                                          key={ch.id}
                                          onClick={() => {
                                            if (active) {
                                              setChannelSounds((prev) => {
                                                const next = { ...prev };
                                                delete next[ch.id];
                                                return next;
                                              });
                                            } else {
                                              setChannelSounds((prev) => ({
                                                ...prev,
                                                [ch.id]: { enabled: true, volume: 80, useCustom: false },
                                              }));
                                            }
                                          }}
                                          className={`px-2 py-1 rounded-oct-sm border font-mono text-xs transition-colors duration-100 ${active ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent' : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'}`}
                                        >
                                          {ch.name}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Per-channel sound configs */}
                            {enabledIds.length > 0 && (
                              <div className="space-y-2 mt-2">
                                {enabledIds.map((chId) => {
                                  const sc = channelSounds[chId];
                                  const chInfo = channels.find((c) => c.id === chId);
                                  const isTg = chInfo?.source === 'telegram';
                                  const label = chInfo ? (isTg ? chInfo.name : `#${chInfo.name}`) : `#${chId}`;
                                  return (
                                    <div key={chId} className="rounded-oct border border-oct-border bg-oct-surface-raised px-2 sm:px-3 py-2.5 sm:py-3 space-y-2.5">
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                                          <Volume2 size={14} className="text-oct-muted shrink-0" />
                                          {isTg && <Send size={12} className="text-oct-accent shrink-0" />}
                                          <span className="text-xs sm:text-sm text-oct-text font-medium truncate">{label}</span>
                                          {isTg
                                            ? <span className="font-mono text-[11px] text-oct-accent hidden sm:inline">Telegram</span>
                                            : chInfo?.guildName && <span className="font-mono text-[11px] text-oct-muted hidden sm:inline">{chInfo.guildName}</span>
                                          }
                                        </div>
                                        <div className="flex items-center gap-2">
                                          <button
                                            onClick={() => previewSound('highlight', sc)}
                                            className="p-1 rounded-oct-sm text-oct-muted hover:text-oct-accent hover:bg-oct-surface transition-colors duration-100"
                                            title="Preview sound"
                                          >
                                            <Play size={14} />
                                          </button>
                                          <div
                                            className={`w-9 h-[18px] rounded-full transition-colors duration-100 relative cursor-pointer ${sc.enabled ? 'bg-oct-green' : 'bg-oct-border-bright'}`}
                                            onClick={() => setChannelSounds((prev) => ({
                                              ...prev,
                                              [chId]: { ...prev[chId], enabled: !prev[chId].enabled },
                                            }))}
                                          >
                                            <div className={`absolute top-[2px] w-[14px] h-[14px] bg-oct-text rounded-full transition-transform duration-100 ${sc.enabled ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
                                          </div>
                                        </div>
                                      </div>

                                      {sc.enabled && (
                                        <>
                                          <div className="flex items-center gap-3">
                                            <span className="font-mono text-[11px] text-oct-muted w-12 shrink-0 uppercase tracking-wide">Volume</span>
                                            <input
                                              type="range"
                                              min={0}
                                              max={100}
                                              value={sc.volume}
                                              onChange={(e) => setChannelSounds((prev) => ({
                                                ...prev,
                                                [chId]: { ...prev[chId], volume: Number(e.target.value) },
                                              }))}
                                              className="flex-1 h-1.5 accent-oct-accent cursor-pointer"
                                            />
                                            <span className="font-mono text-[11px] text-oct-muted w-8 text-right">{sc.volume}%</span>
                                          </div>
                                          <div className="space-y-2">
                                            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                                              <span className="font-mono text-[11px] text-oct-muted uppercase tracking-wide">Sound:</span>
                                              <button
                                                onClick={() => setChannelSounds((prev) => ({ ...prev, [chId]: { ...prev[chId], useCustom: false, presetSound: undefined } }))}
                                                className={`px-2 py-1 rounded-oct-sm border font-mono text-[11px] font-bold uppercase tracking-wide transition-colors duration-100 ${!sc.useCustom && !sc.presetSound ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent' : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'}`}
                                              >
                                                Default
                                              </button>
                                              <button
                                                onClick={() => setChannelSounds((prev) => ({ ...prev, [chId]: { ...prev[chId], useCustom: false, presetSound: prev[chId].presetSound || 'ping' } }))}
                                                className={`px-2 py-1 rounded-oct-sm border font-mono text-[11px] font-bold uppercase tracking-wide transition-colors duration-100 ${!sc.useCustom && sc.presetSound ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent' : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'}`}
                                              >
                                                Preset
                                              </button>
                                              <button
                                                onClick={() => {
                                                  if (sc.customSoundUrl) {
                                                    setChannelSounds((prev) => ({ ...prev, [chId]: { ...prev[chId], useCustom: true, presetSound: undefined } }));
                                                  } else {
                                                    setUploadingChannelId(chId);
                                                    channelFileInputRef.current?.click();
                                                  }
                                                }}
                                                className={`px-2 py-1 rounded-oct-sm border font-mono text-[11px] font-bold uppercase tracking-wide transition-colors duration-100 ${sc.useCustom ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent' : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'}`}
                                              >
                                                Custom
                                              </button>
                                            </div>
                                            {!sc.useCustom && sc.presetSound && (
                                              <div className="flex flex-wrap gap-1.5">
                                                {PRESET_SOUNDS.map((preset) => (
                                                  <button
                                                    key={preset.id}
                                                    onClick={() => {
                                                      setChannelSounds((prev) => ({ ...prev, [chId]: { ...prev[chId], presetSound: preset.id } }));
                                                      previewPreset(preset.id, sc.volume);
                                                    }}
                                                    className={`px-2 py-1 rounded-oct-sm border font-mono text-[11px] transition-colors duration-100 ${sc.presetSound === preset.id ? 'bg-oct-accent border-oct-accent/50 text-white shadow-oct-glow-accent' : 'bg-oct-surface-raised/40 border-oct-border text-oct-muted hover:text-oct-text hover:border-oct-border-bright'}`}
                                                  >
                                                    {preset.label}
                                                  </button>
                                                ))}
                                              </div>
                                            )}
                                            {sc.useCustom && (
                                              <div className="flex items-center gap-2">
                                                {sc.customSoundUrl && (
                                                  <span className="font-mono text-[11px] text-oct-muted truncate">{sc.customSoundUrl.split('/').pop()}</span>
                                                )}
                                                <button
                                                  onClick={() => { setUploadingChannelId(chId); channelFileInputRef.current?.click(); }}
                                                  className="p-1 rounded-oct-sm text-oct-muted hover:text-oct-accent hover:bg-oct-surface transition-colors duration-100"
                                                  title="Upload sound"
                                                >
                                                  <Upload size={12} />
                                                </button>
                                                {sc.customSoundUrl && (
                                                  <button
                                                    onClick={async () => {
                                                      await fetch(`/api/channel-sounds/${chId}`, { method: 'DELETE' });
                                                      setChannelSounds((prev) => ({
                                                        ...prev,
                                                        [chId]: { ...prev[chId], useCustom: false, customSoundUrl: undefined },
                                                      }));
                                                    }}
                                                    className="text-oct-muted hover:text-oct-flame transition-colors duration-100"
                                                    title="Remove custom sound"
                                                  >
                                                    <Trash2 size={12} />
                                                  </button>
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                  </div>
                </div>
              </>
  );
}
