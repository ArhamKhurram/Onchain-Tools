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

export default function PushoverSection({ form }: { form: SettingsForm }) {
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
                  <h3 className="text-base sm:text-lg font-semibold text-white mb-4">Pushover</h3>
                  <div className="space-y-4">
                    <p className="text-sm text-discord-text-muted">
                      Send push notifications to your phone via{' '}
                      <a href="https://pushover.net" target="_blank" rel="noopener noreferrer" className="text-discord-text-link hover:underline">
                        pushover.net
                      </a>
                      . Configure which events trigger notifications and filter by user, guild, or channel.
                    </p>

                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Setup Guide</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3">
                        <div className="space-y-2">
                          <div className="flex items-start gap-2.5">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-discord-blurple text-white text-xs font-bold flex items-center justify-center mt-0.5">1</span>
                            <p className="text-sm text-discord-text">
                              Create a Pushover account at{' '}
                              <a href="https://pushover.net" target="_blank" rel="noopener noreferrer" className="text-discord-text-link hover:underline">pushover.net</a>
                              {' '}and install the app on your{' '}
                              <a href="https://pushover.net/clients" target="_blank" rel="noopener noreferrer" className="text-discord-text-link hover:underline">phone</a>.
                            </p>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-discord-blurple text-white text-xs font-bold flex items-center justify-center mt-0.5">2</span>
                            <p className="text-sm text-discord-text">
                              Copy your <span className="font-semibold text-white">User Key</span> from the{' '}
                              <a href="https://pushover.net" target="_blank" rel="noopener noreferrer" className="text-discord-text-link hover:underline">Pushover dashboard</a>
                              {' '}(shown at the top of the page after logging in).
                            </p>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-discord-blurple text-white text-xs font-bold flex items-center justify-center mt-0.5">3</span>
                            <div className="text-sm text-discord-text">
                              <p>
                                Create a new application at{' '}
                                <a href="https://pushover.net/apps/build" target="_blank" rel="noopener noreferrer" className="text-discord-text-link hover:underline">pushover.net/apps/build</a>:
                              </p>
                              <ul className="mt-1.5 ml-1 space-y-1 text-discord-text-muted text-xs">
                                <li className="flex items-start gap-1.5"><span className="text-discord-blurple font-bold">·</span> Name it anything (e.g. "OCT")</li>
                                <li className="flex items-start gap-1.5"><span className="text-discord-blurple font-bold">·</span> Type: Application</li>
                                <li className="flex items-start gap-1.5"><span className="text-discord-blurple font-bold">·</span> Description and URL are optional</li>
                              </ul>
                            </div>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-discord-blurple text-white text-xs font-bold flex items-center justify-center mt-0.5">4</span>
                            <p className="text-sm text-discord-text">
                              Copy the <span className="font-semibold text-white">API Token/Key</span> from your newly created application page and paste it below.
                            </p>
                          </div>
                        </div>
                        <p className="text-xs text-discord-text-muted px-1">
                          Pushover offers a 30-day free trial, then a one-time $5 purchase per platform.
                        </p>
                      </div>
                    </details>

                    <Toggle
                      value={pushoverEnabled}
                      onChange={setPushoverEnabled}
                      label="Enable Pushover notifications"
                    />

                    {pushoverEnabled && (
                      <div className="space-y-4">
                        <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg space-y-3">
                          <h4 className="text-sm font-semibold text-white">Credentials</h4>
                          <div className="px-3 py-2 bg-discord-dark rounded">
                            <label className="text-[11px] text-discord-text-muted mb-1 block">Application API Token</label>
                            <input
                              type="password"
                              value={pushoverAppToken}
                              onChange={(e) => setPushoverAppToken(e.target.value)}
                              placeholder="azGDORePK8gMaC0QOYAMyEEuzJnyUi"
                              className="w-full bg-discord-sidebar border-none rounded px-2 py-1.5 text-sm text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple font-mono"
                              autoComplete="off"
                              data-1p-ignore
                              data-lpignore="true"
                              data-form-type="other"
                            />
                          </div>
                          <div className="px-3 py-2 bg-discord-dark rounded">
                            <label className="text-[11px] text-discord-text-muted mb-1 block">User Key</label>
                            <input
                              type="password"
                              value={pushoverUserKey}
                              onChange={(e) => setPushoverUserKey(e.target.value)}
                              placeholder="uQiRzpo4DXghDmr9QzzfQu27cmVRsG"
                              className="w-full bg-discord-sidebar border-none rounded px-2 py-1.5 text-sm text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple font-mono"
                              autoComplete="off"
                              data-1p-ignore
                              data-lpignore="true"
                              data-form-type="other"
                            />
                          </div>
                        </div>

                        <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg space-y-3">
                          <h4 className="text-sm font-semibold text-white">Triggers</h4>
                          <p className="text-xs text-discord-text-muted">Choose which events send a push notification.</p>
                          <Toggle
                            value={pushoverTriggers.highlightedUserContract}
                            onChange={(v) => setPushoverTriggers((p) => ({ ...p, highlightedUserContract: v }))}
                            label="Highlighted user posts a contract"
                          />
                          <Toggle
                            value={pushoverTriggers.highlightedUser}
                            onChange={(v) => setPushoverTriggers((p) => ({ ...p, highlightedUser: v }))}
                            label="Highlighted user sends any message"
                          />
                          <Toggle
                            value={pushoverTriggers.contract}
                            onChange={(v) => setPushoverTriggers((p) => ({ ...p, contract: v }))}
                            label="Any contract address detected"
                          />
                          <Toggle
                            value={pushoverTriggers.keyword}
                            onChange={(v) => setPushoverTriggers((p) => ({ ...p, keyword: v }))}
                            label="Keyword pattern matched"
                          />
                          <Toggle
                            value={pushoverTriggers.signalConvergence ?? false}
                            onChange={(v) => setPushoverTriggers((p) => ({ ...p, signalConvergence: v }))}
                            label="Signal convergence (contract call + FOMO buy overlap)"
                          />
                        </div>

                        <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg space-y-3">
                          <h4 className="text-sm font-semibold text-white">Filters</h4>
                          <p className="text-xs text-discord-text-muted">Narrow down which messages trigger notifications. Empty = no filter (all match).</p>

                          {/* User filter */}
                          <div className="px-2 sm:px-3 py-2 bg-discord-dark rounded space-y-2">
                            <label className="text-[11px] text-discord-text-muted block">Only from these highlighted users</label>
                            {(() => {
                              const allHighlighted = Array.from(new Set([
                                ...(config?.globalHighlightedUsers ?? []),
                                ...(config?.rooms ?? []).flatMap((r) => r.highlightedUsers),
                              ]));
                              if (allHighlighted.length === 0) return <p className="text-xs text-discord-text-muted italic">No highlighted users configured</p>;
                              return (
                                <div className="flex flex-wrap gap-1.5">
                                  {allHighlighted.map((uid) => {
                                    const active = pushoverFilters.userIds.includes(uid);
                                    return (
                                      <button
                                        key={uid}
                                        onClick={() => setPushoverFilters((f) => ({
                                          ...f,
                                          userIds: active ? f.userIds.filter((id) => id !== uid) : [...f.userIds, uid],
                                        }))}
                                        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${active ? 'bg-discord-blurple text-white' : 'bg-discord-sidebar text-discord-text-muted hover:text-discord-text'}`}
                                      >
                                        {userNameMap.get(uid) || uid}
                                      </button>
                                    );
                                  })}
                                  {pushoverFilters.userIds.length > 0 && (
                                    <button
                                      onClick={() => setPushoverFilters((f) => ({ ...f, userIds: [] }))}
                                      className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 transition-colors"
                                    >
                                      Clear
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                          </div>

                          {/* Guild filter */}
                          <div className="px-2 sm:px-3 py-2 bg-discord-dark rounded space-y-2">
                            <label className="text-[11px] text-discord-text-muted block">Only from these guilds</label>
                            {(() => {
                              const filtered = guilds.filter((g) => enabledGuilds.includes(g.id));
                              if (filtered.length === 0) return <p className="text-xs text-discord-text-muted italic">No enabled guilds</p>;
                              return (
                              <div className="flex flex-wrap gap-1.5">
                                {filtered.map((g) => {
                                  const active = pushoverFilters.guildIds.includes(g.id);
                                  return (
                                    <button
                                      key={g.id}
                                      onClick={() => setPushoverFilters((f) => ({
                                        ...f,
                                        guildIds: active ? f.guildIds.filter((id) => id !== g.id) : [...f.guildIds, g.id],
                                      }))}
                                      className={`px-2 py-1 rounded text-xs font-medium transition-colors ${active ? 'bg-discord-blurple text-white' : 'bg-discord-sidebar text-discord-text-muted hover:text-discord-text'}`}
                                    >
                                      {g.name}
                                    </button>
                                  );
                                })}
                                {pushoverFilters.guildIds.length > 0 && (
                                  <button
                                    onClick={() => setPushoverFilters((f) => ({ ...f, guildIds: [] }))}
                                    className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 transition-colors"
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                              );
                            })()}
                          </div>

                          {/* Channel filter */}
                          <div className="px-2 sm:px-3 py-2 bg-discord-dark rounded space-y-2">
                            <label className="text-[11px] text-discord-text-muted block">Only from these channels</label>
                            {(() => {
                              const rooms = config?.rooms ?? [];
                              const seen = new Set<string>();
                              const channels: { id: string; name: string; guildName: string | null }[] = [];
                              for (const room of rooms) {
                                for (const ch of room.channels) {
                                  if (!seen.has(ch.channelId)) {
                                    seen.add(ch.channelId);
                                    channels.push({ id: ch.channelId, name: ch.channelName ?? ch.channelId, guildName: ch.guildName ?? null });
                                  }
                                }
                              }
                              if (channels.length === 0) return <p className="text-xs text-discord-text-muted italic">No channels in rooms</p>;
                              const grouped = new Map<string, typeof channels>();
                              for (const ch of channels) {
                                const key = ch.guildName ?? 'DMs';
                                if (!grouped.has(key)) grouped.set(key, []);
                                grouped.get(key)!.push(ch);
                              }
                              return (
                                <div className="space-y-2">
                                  {Array.from(grouped.entries()).map(([guildName, guildChannels]) => (
                                    <div key={guildName}>
                                      <p className="text-[10px] text-discord-text-muted uppercase tracking-wider mb-1">{guildName}</p>
                                      <div className="flex flex-wrap gap-1.5">
                                        {guildChannels.map((ch) => {
                                          const active = pushoverFilters.channelIds.includes(ch.id);
                                          return (
                                            <button
                                              key={ch.id}
                                              onClick={() => setPushoverFilters((f) => ({
                                                ...f,
                                                channelIds: active ? f.channelIds.filter((id) => id !== ch.id) : [...f.channelIds, ch.id],
                                              }))}
                                              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${active ? 'bg-discord-blurple text-white' : 'bg-discord-sidebar text-discord-text-muted hover:text-discord-text'}`}
                                            >
                                              #{ch.name}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  ))}
                                  {pushoverFilters.channelIds.length > 0 && (
                                    <button
                                      onClick={() => setPushoverFilters((f) => ({ ...f, channelIds: [] }))}
                                      className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 transition-colors"
                                    >
                                      Clear
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </div>

                        <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg space-y-3">
                          <h4 className="text-sm font-semibold text-white">Notification Settings</h4>
                          <div className="px-3 py-2 bg-discord-dark rounded">
                            <label className="text-[11px] text-discord-text-muted mb-1 block">Priority</label>
                            <select
                              value={pushoverPriority}
                              onChange={(e) => setPushoverPriority(Number(e.target.value) as PushoverPriority)}
                              className="w-full bg-discord-sidebar border-none rounded px-2 py-1.5 text-sm text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple"
                            >
                              <option value={-2}>Lowest (no alert)</option>
                              <option value={-1}>Low (no sound)</option>
                              <option value={0}>Normal</option>
                              <option value={1}>High (bypass quiet hours)</option>
                              <option value={2}>Emergency (repeats until acknowledged)</option>
                            </select>
                          </div>
                          <div className="px-3 py-2 bg-discord-dark rounded">
                            <label className="text-[11px] text-discord-text-muted mb-1 block">Sound</label>
                            <select
                              value={pushoverSound}
                              onChange={(e) => setPushoverSound(e.target.value as PushoverSound)}
                              className="w-full bg-discord-sidebar border-none rounded px-2 py-1.5 text-sm text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple capitalize"
                            >
                              {PUSHOVER_SOUNDS.map((s) => (
                                <option key={s} value={s}>{s === 'none' ? 'None (silent)' : s}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg space-y-3 border border-discord-blurple/30">
                      <h4 className="text-sm font-semibold text-white">Missed runner alerts</h4>
                      <p className="text-xs text-discord-text-muted">
                        Notify when a scanned token hits your multiplier vs MC@call and none of your My Wallets hold it.
                      </p>
                      <Toggle
                        value={missedRunnerEnabled}
                        onChange={setMissedRunnerEnabled}
                        label="Enable missed-runner monitoring"
                      />
                      {missedRunnerEnabled && (
                        <div className="space-y-3 pt-1">
                          <div>
                            <label className="text-[11px] text-discord-text-muted mb-2 block">Deliver via</label>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                              {MISSED_RUNNER_NOTIFY_OPTIONS.map(({ value, label, hint }) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={() => setMissedRunnerNotifyVia(value)}
                                  className={`px-2 py-2 rounded text-left border transition-colors ${
                                    missedRunnerNotifyVia === value
                                      ? 'bg-discord-blurple/20 border-discord-blurple text-white'
                                      : 'bg-discord-dark border-discord-input text-discord-text-muted hover:text-discord-text'
                                  }`}
                                >
                                  <span className="block text-xs font-semibold">{label}</span>
                                  <span className="block text-[10px] opacity-80 mt-0.5">{hint}</span>
                                </button>
                              ))}
                            </div>
                            {(missedRunnerNotifyVia === 'pushover' || missedRunnerNotifyVia === 'both') && !pushoverEnabled && (
                              <p className="text-[11px] text-orange-400 mt-2">
                                Enable Pushover above and add credentials for phone pushes.
                              </p>
                            )}
                            {(missedRunnerNotifyVia === 'toast' || missedRunnerNotifyVia === 'both') && (
                              <p className="text-[10px] text-discord-text-muted mt-2">
                                Toast position: Settings → Sounds &amp; Notifications → On-site toast alerts.
                              </p>
                            )}
                          </div>
                          <div className="px-2 sm:px-3 py-2 bg-discord-dark rounded">
                            <label className="text-[11px] text-discord-text-muted mb-1 block">
                              Multiplier threshold: {missedRunnerMultiplier.toFixed(2)}× vs MC@call
                            </label>
                            <input
                              type="range"
                              min={1.25}
                              max={5}
                              step={0.05}
                              value={missedRunnerMultiplier}
                              onChange={(e) => setMissedRunnerMultiplier(Number(e.target.value))}
                              className="w-full accent-discord-blurple"
                            />
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div className="px-2 sm:px-3 py-2 bg-discord-dark rounded">
                              <label className="text-[11px] text-discord-text-muted mb-1 block">Lookback (hours)</label>
                              <input
                                type="number"
                                min={1}
                                max={168}
                                value={missedRunnerLookbackHours}
                                onChange={(e) => setMissedRunnerLookbackHours(Math.max(1, Number(e.target.value) || 24))}
                                className="w-full bg-discord-sidebar border-none rounded px-2 py-1.5 text-sm text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple"
                              />
                            </div>
                            <div className="px-2 sm:px-3 py-2 bg-discord-dark rounded">
                              <label className="text-[11px] text-discord-text-muted mb-1 block">Cooldown per token (hours)</label>
                              <input
                                type="number"
                                min={1}
                                max={168}
                                value={missedRunnerCooldownHours}
                                onChange={(e) => setMissedRunnerCooldownHours(Math.max(1, Number(e.target.value) || 24))}
                                className="w-full bg-discord-sidebar border-none rounded px-2 py-1.5 text-sm text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple"
                              />
                            </div>
                          </div>
                          <div className="px-2 sm:px-3 py-2 bg-discord-dark rounded">
                            <label className="text-[11px] text-discord-text-muted mb-1 block">Min MC@call (optional, USD)</label>
                            <input
                              type="number"
                              min={0}
                              placeholder="e.g. 50000 — skip lower MC scans"
                              value={missedRunnerMinMcAtCall}
                              onChange={(e) => setMissedRunnerMinMcAtCall(e.target.value)}
                              className="w-full bg-discord-sidebar border-none rounded px-2 py-1.5 text-sm text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple"
                            />
                          </div>
                          <p className="text-[11px] text-discord-text-muted">
                            Balance checks use Wallets → My Wallets. Keep the site open for toast delivery.
                          </p>
                          <div className="pt-2 border-t border-discord-input/40 space-y-2">
                            <label className="text-[11px] text-discord-text-muted block">Test on a token</label>
                            <p className="text-[10px] text-discord-text-muted">
                              Paste a contract from your feed to preview the alert. Does not write cooldown rows.
                            </p>
                            <input
                              type="text"
                              value={missedRunnerTestAddress}
                              onChange={(e) => {
                                setMissedRunnerTestAddress(e.target.value);
                                setMissedRunnerTestResult(null);
                              }}
                              placeholder="0x647dd517c8820fc9874e1a3f58e6e0b9a43395c0"
                              className="w-full bg-discord-dark border border-discord-input rounded px-2 py-1.5 text-sm text-discord-text font-mono outline-none focus:ring-1 focus:ring-discord-blurple"
                            />
                            <Toggle
                              value={missedRunnerTestForce}
                              onChange={(v) => {
                                setMissedRunnerTestForce(v);
                                setMissedRunnerTestResult(null);
                              }}
                              label="Force send (ignore multiplier & cooldown)"
                            />
                            <button
                              type="button"
                              onClick={() => void handleMissedRunnerTest()}
                              disabled={missedRunnerTestLoading || !missedRunnerTestAddress.trim()}
                              className="px-3 py-1.5 rounded text-xs font-medium bg-discord-blurple hover:bg-discord-blurple-hover text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {missedRunnerTestLoading ? 'Running…' : 'Run test alert'}
                            </button>
                            {missedRunnerTestResult && (
                              <div
                                className={`text-[11px] rounded px-2 py-2 ${
                                  missedRunnerTestResult.sent
                                    ? 'bg-discord-green/15 text-discord-green border border-discord-green/30'
                                    : missedRunnerTestResult.ok
                                      ? 'bg-discord-yellow/10 text-discord-yellow border border-discord-yellow/30'
                                      : 'bg-red-500/10 text-red-400 border border-red-500/30'
                                }`}
                              >
                                <p>{missedRunnerTestResult.message}</p>
                                {missedRunnerTestResult.diagnostics && (
                                  <p className="mt-1 opacity-90 font-mono text-[10px]">
                                    {missedRunnerTestResult.diagnostics.mcAtCallDisplay != null && (
                                      <>MC@call {missedRunnerTestResult.diagnostics.mcAtCallDisplay}</>
                                    )}
                                    {missedRunnerTestResult.diagnostics.mcNowDisplay != null && (
                                      <> → {missedRunnerTestResult.diagnostics.mcNowDisplay}</>
                                    )}
                                    {missedRunnerTestResult.diagnostics.multiplier != null && (
                                      <> · {missedRunnerTestResult.diagnostics.multiplier.toFixed(2)}×</>
                                    )}
                                    {missedRunnerTestResult.diagnostics.minMultiplier != null && (
                                      <> (need {missedRunnerTestResult.diagnostics.minMultiplier.toFixed(2)}×)</>
                                    )}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
  );
}
