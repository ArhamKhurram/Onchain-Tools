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

export default function TokensSection({ form }: { form: SettingsForm }) {
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
                  <h3 className="text-base sm:text-base sm:text-lg font-semibold text-white mb-1">Discord Tokens</h3>
                  <p className="text-xs sm:text-sm text-discord-text-muted mb-3 sm:mb-4">
                    Manage your Discord authentication tokens. Multiple tokens allow monitoring across different accounts.
                    {isClientGatewayMode() && (
                      <span className="block mt-2 text-discord-yellow/90">
                        Hosted mode: tokens are stored only in this browser and connect directly to Discord — they never touch our servers.
                      </span>
                    )}
                  </p>

                  {maskedTokens.length > 0 && (
                    <div className="space-y-1.5 mb-4">
                      {maskedTokens.map((t) => (
                        <div
                          key={t.index}
                          className={`flex items-center justify-between gap-2 px-2 sm:px-3 py-2 sm:py-2.5 rounded ${t.invalid ? 'bg-discord-red/10 ring-1 ring-discord-red/40' : 'bg-discord-sidebar'}`}
                        >
                          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                            <Key size={14} className={`shrink-0 ${t.invalid ? 'text-discord-red' : 'text-discord-blurple'}`} />
                            <span className="text-xs sm:text-sm text-discord-text font-mono tracking-wider truncate">{t.masked}</span>
                            <span className={`text-[10px] px-1 sm:px-1.5 py-0.5 rounded font-semibold shrink-0 ${t.invalid ? 'bg-discord-red/20 text-discord-red' : 'bg-discord-blurple/20 text-discord-blurple'}`}>
                              #{t.index + 1}
                            </span>
                            {t.invalid && (
                              <span className="flex items-center gap-1 text-[10px] px-1 sm:px-1.5 py-0.5 rounded bg-discord-red/20 text-discord-red font-semibold shrink-0">
                                <AlertTriangle size={11} />
                                Invalid
                              </span>
                            )}
                          </div>
                          <button
                            onClick={async () => { await removeToken(t.index); }}
                            className="text-discord-text-muted hover:text-discord-red shrink-0"
                            title="Remove token"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {maskedTokens.length === 0 && (
                    <p className="text-sm text-discord-text-muted text-center py-3 mb-4 bg-discord-sidebar/50 rounded">
                      No tokens configured.
                    </p>
                  )}

                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <input
                        type={showNewToken ? 'text' : 'password'}
                        value={newToken}
                        onChange={(e) => { setNewToken(e.target.value); setTokenError(''); }}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter' && newToken.trim()) {
                            setAddingToken(true);
                            setTokenError('');
                            const result = await addToken(newToken.trim());
                            if (result.success) { setNewToken(''); setShowNewToken(false); }
                            else { setTokenError(result.error ?? 'Failed to add token'); }
                            setAddingToken(false);
                          }
                        }}
                        placeholder="Paste Discord token..."
                        name="oct-token-field"
                        className="w-full bg-discord-sidebar border-none rounded px-2 sm:px-3 py-2 pr-8 sm:pr-9 text-xs sm:text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple font-mono"
                        disabled={addingToken}
                        autoComplete="one-time-code"
                        data-1p-ignore
                        data-lpignore="true"
                        data-form-type="other"
                      />
                      <button
                        onClick={() => setShowNewToken(!showNewToken)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-discord-text-muted hover:text-discord-text"
                        type="button"
                        tabIndex={-1}
                      >
                        {showNewToken ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <button
                      onClick={async () => {
                        if (!newToken.trim()) return;
                        setAddingToken(true);
                        setTokenError('');
                        const result = await addToken(newToken.trim());
                        if (result.success) { setNewToken(''); setShowNewToken(false); }
                        else { setTokenError(result.error ?? 'Failed to add token'); }
                        setAddingToken(false);
                      }}
                      disabled={addingToken || !newToken.trim()}
                      className="px-3 py-2 bg-discord-blurple hover:bg-discord-blurple-hover disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm text-white transition-colors"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  {tokenError && (
                    <p className="text-xs text-discord-red mt-1.5">{tokenError}</p>
                  )}
                </div>

                {/* Connection / Proxy (desktop only) */}
                {!isHostedMode && (
                  <div className="mt-8 pt-6 border-t border-discord-divider">
                    <h3 className="text-base sm:text-lg font-semibold text-white mb-1">Connection</h3>
                    <p className="text-xs sm:text-sm text-discord-text-muted mb-3 sm:mb-4">
                      If Discord won't load on a VPN, route the connection through an HTTP/HTTPS proxy.
                      Leave blank to connect directly. SOCKS proxies are not supported.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={proxyUrl}
                        onChange={(e) => { setProxyUrl(e.target.value); setProxySaved(false); }}
                        placeholder="http://user:pass@host:port"
                        className="flex-1 bg-discord-sidebar border-none rounded px-2 sm:px-3 py-2 text-xs sm:text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple font-mono"
                        disabled={proxySaving}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        onClick={async () => {
                          setProxySaving(true);
                          setProxySaved(false);
                          await updateConfig({ discordProxyUrl: proxyUrl.trim() });
                          setProxySaving(false);
                          setProxySaved(true);
                        }}
                        disabled={proxySaving || proxyUrl.trim() === (config?.discordProxyUrl ?? '')}
                        className="px-3 py-2 bg-discord-blurple hover:bg-discord-blurple-hover disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm text-white transition-colors whitespace-nowrap"
                      >
                        {proxySaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                    {proxySaved && (
                      <p className="text-xs text-discord-green mt-1.5">
                        Saved. Reconnecting Discord{proxyUrl.trim() ? ' through the proxy' : ' directly'}…
                      </p>
                    )}
                  </div>
                )}

                {/* Telegram Section */}
                <div className="mt-8 pt-6 border-t border-discord-divider">
                  <h3 className="text-base sm:text-lg font-semibold text-white mb-1">Telegram</h3>
                  <p className="text-xs sm:text-sm text-discord-text-muted mb-3 sm:mb-4">
                    Connect your Telegram account to combine TG chats with Discord channels in your rooms.
                  </p>

                  {authStatus?.telegramConnected ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-3 py-2.5 bg-discord-sidebar rounded">
                        <div className="w-2 h-2 rounded-full bg-discord-green" />
                        <span className="text-sm text-discord-text">Telegram connected</span>
                      </div>
                      <button
                        onClick={async () => {
                          await telegramDisconnect();
                        }}
                        className="px-4 py-2 bg-discord-red/20 hover:bg-discord-red/30 text-discord-red rounded text-sm font-medium transition-colors"
                      >
                        Disconnect Telegram
                      </button>
                    </div>
                  ) : authStatus?.telegramConfigured ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-3 py-2.5 bg-discord-sidebar rounded">
                        <div className="w-2 h-2 rounded-full bg-yellow-500" />
                        <span className="text-sm text-discord-text">Telegram configured but not connected</span>
                      </div>
                      <button
                        onClick={async () => {
                          await telegramDisconnect();
                        }}
                        className="px-4 py-2 bg-discord-red/20 hover:bg-discord-red/30 text-discord-red rounded text-sm font-medium transition-colors"
                      >
                        Remove Telegram Session
                      </button>
                    </div>
                  ) : (
                    <div>
                      {showTelegramSetup ? (
                        <TelegramSetup onClose={() => setShowTelegramSetup(false)} />
                      ) : (
                        <button
                          onClick={() => setShowTelegramSetup(true)}
                          className="px-4 py-2.5 bg-[#2AABEE] hover:bg-[#229ED9] rounded text-sm font-medium text-white transition-colors"
                        >
                          Connect Telegram
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
  );
}
