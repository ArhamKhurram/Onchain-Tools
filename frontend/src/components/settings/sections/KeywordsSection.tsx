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

export default function KeywordsSection({ form }: { form: SettingsForm }) {
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
                  <h3 className="text-base sm:text-lg font-semibold text-white mb-4">Keywords</h3>

                  <div className="space-y-5">
                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Keyword Alerts</h4>
                      <Toggle
                        value={keywordAlertsEnabled}
                        onChange={setKeywordAlertsEnabled}
                        label="Enable keyword/regex pattern matching alerts"
                      />
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Global Keyword Patterns</h4>
                      <p className="text-sm text-discord-text-muted mb-2">
                        Add patterns to match against messages globally. Use <strong className="text-discord-text">Contains</strong> for substring matches, <strong className="text-discord-text">Exact</strong> for whole-word matches, or <strong className="text-discord-text">Regex</strong> for advanced patterns.
                      </p>
                      <div className="text-xs text-discord-text-muted bg-discord-dark rounded px-3 py-2 mb-4 space-y-1">
                        <p className="font-semibold text-discord-text-muted/80">Regex examples:</p>
                        <p><code className="text-orange-400/80 font-mono">stealth\s*(launch|drop)</code> — stealth launch, stealthdrop</p>
                        <p><code className="text-orange-400/80 font-mono">\b(airdrop|air\s*drop)\b</code> — airdrop, air drop (whole word)</p>
                        <p><code className="text-orange-400/80 font-mono">deploy(ed|ing)?</code> — deploy, deployed, deploying</p>
                        <p><code className="text-orange-400/80 font-mono">ca\s*[:=]\s*0x[a-f0-9]+</code> — ca: 0xABC..., CA=0x...</p>
                        <p className="pt-1">Build & test patterns at <a href="https://regex101.com" target="_blank" rel="noopener noreferrer" className="text-discord-blurple hover:underline">regex101.com</a></p>
                      </div>

                      <div className="space-y-3 mb-4">
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={newKeywordPattern}
                            onChange={(e) => setNewKeywordPattern(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') addKeyword(); }}
                            placeholder={
                              newKeywordMatchMode === 'regex' ? 'Regex pattern (e.g. launch|stealth)'
                              : newKeywordMatchMode === 'exact' ? 'Exact word (e.g. launch)'
                              : 'Keyword (e.g. stealth launch)'
                            }
                            className="flex-1 bg-discord-dark border-none rounded px-3 py-2 text-sm text-discord-text outline-none focus:ring-2 focus:ring-discord-blurple font-mono"
                          />
                          <button
                            onClick={addKeyword}
                            className="px-3 py-2 bg-discord-blurple hover:bg-discord-blurple-hover rounded text-sm text-white transition-colors"
                          >
                            <Plus size={16} />
                          </button>
                        </div>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                          <div className="flex rounded overflow-hidden border border-discord-divider shrink-0">
                            {(['includes', 'exact', 'regex'] as KeywordMatchMode[]).map((mode) => (
                              <button
                                key={mode}
                                onClick={() => setNewKeywordMatchMode(mode)}
                                className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                  newKeywordMatchMode === mode
                                    ? 'bg-discord-blurple text-white'
                                    : 'bg-discord-dark text-discord-text-muted hover:text-discord-text'
                                }`}
                              >
                                {mode === 'includes' ? 'Contains' : mode === 'exact' ? 'Exact' : 'Regex'}
                              </button>
                            ))}
                          </div>
                          <input
                            type="text"
                            value={newKeywordLabel}
                            onChange={(e) => setNewKeywordLabel(e.target.value)}
                            placeholder="Label (optional)"
                            className="flex-1 bg-discord-dark border-none rounded px-3 py-1.5 text-xs text-discord-text outline-none focus:ring-1 focus:ring-discord-blurple"
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        {globalKeywordPatterns.length === 0 && (
                          <p className="text-sm text-discord-text-muted text-center py-4">
                            No keyword patterns configured.
                          </p>
                        )}
                        {globalKeywordPatterns.map((kw, idx) => (
                          <div key={idx} className="flex items-center justify-between gap-2 px-2 sm:px-3 py-2 bg-discord-dark rounded">
                            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                              {(kw.matchMode === 'regex' || (!kw.matchMode && kw.isRegex)) && (
                                <span className="text-[10px] px-1 sm:px-1.5 py-0.5 rounded bg-orange-400/20 text-orange-400 font-semibold shrink-0">REGEX</span>
                              )}
                              {kw.matchMode === 'exact' && (
                                <span className="text-[10px] px-1 sm:px-1.5 py-0.5 rounded bg-discord-blurple/20 text-discord-blurple font-semibold shrink-0">EXACT</span>
                              )}
                              <span className="text-xs sm:text-sm text-discord-text font-mono truncate">{kw.pattern}</span>
                              {kw.label && (
                                <span className="text-[10px] sm:text-[11px] text-discord-text-muted hidden sm:inline">({kw.label})</span>
                              )}
                            </div>
                            <button
                              onClick={() => setGlobalKeywordPatterns((prev) => prev.filter((_, i) => i !== idx))}
                              className="text-discord-text-muted hover:text-discord-red shrink-0"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </>
  );
}
