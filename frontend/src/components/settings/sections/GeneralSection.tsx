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

export default function GeneralSection({ form }: { form: SettingsForm }) {
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
                  <h3 className="text-base sm:text-lg font-semibold text-white mb-4">General</h3>

                  <div className="space-y-5">
                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Message Display</h4>
                      <p className="text-xs sm:text-sm text-discord-text-muted mb-3">
                        Choose how messages are displayed in chat.
                      </p>
                      <div className="flex gap-1.5">
                        {([
                          ['default', 'Cozy'],
                          ['compact', 'Compact'],
                        ] as [MessageDisplay, string][]).map(([mode, label]) => (
                          <button
                            key={mode}
                            onClick={() => setMessageDisplay(mode)}
                            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                              messageDisplay === mode
                                ? 'bg-discord-blurple text-white'
                                : 'bg-discord-dark text-discord-text-muted hover:text-discord-text'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-discord-text-muted mt-2">
                        {messageDisplay === 'default' && 'Cozy mode shows avatars and full message headers.'}
                        {messageDisplay === 'compact' && 'Compact mode shows timestamps on the left with inline usernames for a denser chat view.'}
                      </p>
                      {messageDisplay === 'compact' && (
                        <div className="mt-3 pt-3 border-t border-discord-divider">
                          <Toggle
                            value={compactModeAvatars}
                            onChange={setCompactModeAvatars}
                            label="Show avatars in compact mode"
                          />
                        </div>
                      )}
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Split Screen Layout</h4>
                      <p className="text-xs sm:text-sm text-discord-text-muted mb-3">
                        Use the <strong className="text-discord-text">+</strong> button in a chat header to add up to 4 panes, and the layout button next to Help in the sidebar to resize and drag them. Choose how panes are arranged:
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {([
                          ['row', 'Single row'],
                          ['grid', 'Two rows'],
                        ] as [SplitLayout, string][]).map(([mode, label]) => (
                          <button
                            key={mode}
                            onClick={() => setSplitLayout(mode)}
                            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                              splitLayout === mode
                                ? 'bg-discord-blurple text-white'
                                : 'bg-discord-dark text-discord-text-muted hover:text-discord-text'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Role Colors</h4>
                      <Toggle
                        value={roleColors}
                        onChange={setRoleColors}
                        label="Show Discord role colors on usernames"
                      />
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Mobile Zoom Scale</h4>
                      <p className="text-xs sm:text-sm text-discord-text-muted mb-3">
                        Adjust the zoom level on mobile devices to make everything larger or smaller.
                      </p>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0.5}
                          max={1.5}
                          step={0.05}
                          value={mobileZoomScale}
                          onChange={(e) => setMobileZoomScale(parseFloat(e.target.value))}
                          className="flex-1 h-1.5 bg-discord-dark rounded-full appearance-none cursor-pointer accent-discord-blurple [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-discord-blurple"
                        />
                        <span className="text-xs font-mono text-discord-text w-10 text-right">{Math.round(mobileZoomScale * 100)}%</span>
                      </div>
                      <div className="flex justify-between mt-1.5">
                        <span className="text-[10px] text-discord-text-muted">50%</span>
                        <button
                          onClick={() => setMobileZoomScale(1)}
                          className="text-[10px] text-discord-blurple hover:text-discord-blurple/80 transition-colors"
                        >
                          Reset
                        </button>
                        <span className="text-[10px] text-discord-text-muted">150%</span>
                      </div>
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Contract Detection</h4>
                      <Toggle
                        value={contractDetection}
                        onChange={setContractDetection}
                        label="Detect SOL/EVM contract addresses in messages"
                      />
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Open in Discord App</h4>
                      <Toggle
                        value={openInDiscordApp}
                        onChange={setOpenInDiscordApp}
                        label="Clicking a channel badge opens the message directly in the Discord app"
                      />
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Open in Telegram App</h4>
                      <Toggle
                        value={openInTelegramApp}
                        onChange={setOpenInTelegramApp}
                        label="Clicking a TG channel badge opens the message directly in the Telegram app"
                      />
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Badge Click Action</h4>
                      <p className="text-xs sm:text-sm text-discord-text-muted mb-3">
                        What happens when you click a keyword match or contract badge on a message.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {([
                          ['discord', 'Discord'],
                          ['platform', 'Platform'],
                          ['both', 'Both'],
                        ] as [BadgeClickAction, string][]).map(([action, label]) => (
                          <button
                            key={action}
                            onClick={() => setBadgeClickAction(action)}
                            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                              badgeClickAction === action
                                ? 'bg-discord-blurple text-white'
                                : 'bg-discord-dark text-discord-text-muted hover:text-discord-text'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-discord-text-muted mt-2">
                        {badgeClickAction === 'discord' && 'Always opens the original message in Discord.'}
                        {badgeClickAction === 'platform' && 'Opens the contract in your configured trading platform if one is detected, otherwise falls back to Discord.'}
                        {badgeClickAction === 'both' && 'Opens the message in Discord and also opens the contract in your trading platform (if detected).'}
                      </p>
                    </div>

                    <div className="p-3 sm:p-4 bg-discord-sidebar rounded-lg">
                      <h4 className="text-xs sm:text-sm font-semibold text-white mb-2">Chat / Send Messages</h4>
                      <Toggle
                        value={chattingEnabled}
                        onChange={setChattingEnabled}
                        label="Enable sending messages through OCT"
                      />
                      <div className="mt-3 p-2.5 sm:p-3 rounded bg-discord-red/10 border border-discord-red/30">
                        <p className="text-[11px] sm:text-xs text-discord-red font-semibold mb-1">Warning: Detection Risk</p>
                        <p className="text-[10px] sm:text-[11px] text-discord-text-muted leading-relaxed">
                          Sending messages through this app increases the chance of your Discord account being detected and flagged.
                          Reading messages is passive and harder to detect, but sending messages leaves a direct API footprint
                          that Discord can associate with automated or third-party usage. Use at your own risk.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </>
  );
}
