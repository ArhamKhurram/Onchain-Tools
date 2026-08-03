import { Key, Search, Plus, Trash2, Eye, EyeOff, Volume2, Upload, Play, Users, Shield, Tag, Zap, Settings2, ArrowLeft, HelpCircle, Bell, PanelLeftOpen, Send, Download, AlertTriangle, AtSign } from 'lucide-react';
import type { SolPlatform, EvmPlatform, ContractClickAction, BadgeClickAction, KeywordPattern, KeywordMatchMode, SoundSettings, SoundType, SoundConfig, PushoverPriority, PushoverSound, PushoverTriggers, PushoverFilters, MessageDisplay, FeedChromePreset, SplitLayout, MissedRunnerConfig, MissedRunnerNotifyVia, ToastPosition } from '../../../types';
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
    setMessageDisplay, feedChromePreset, setFeedChromePreset, compactModeAvatars, setCompactModeAvatars, roleColors, setRoleColors, mobileZoomScale,
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
                  <h3 className="font-display text-3xl sm:text-4xl tracking-tight text-oct-text mb-4">General</h3>

                  <div className="space-y-5">
                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Message Display ]</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
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
                            className={`px-3 py-1.5 rounded-cockpit border-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                              messageDisplay === mode
                                ? 'border-oct-accent bg-oct-accent text-white'
                                : 'border-oct-border bg-oct-bg text-oct-muted hover:text-oct-text'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-oct-muted mt-2">
                        {messageDisplay === 'default' && 'Cozy mode shows avatars and full message headers.'}
                        {messageDisplay === 'compact' && 'Compact mode shows timestamps on the left with inline usernames for a denser chat view.'}
                      </p>
                      {messageDisplay === 'compact' && (
                        <div className="mt-3 pt-3 border-t-2 border-oct-border">
                          <Toggle
                            value={compactModeAvatars}
                            onChange={setCompactModeAvatars}
                            label="Show avatars in compact mode"
                          />
                        </div>
                      )}
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Feed Layout ]</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
                        Choose the chrome around the feed — how rooms are picked and where status lives.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {([
                          ['terminal', 'Terminal'],
                          ['masthead', 'Masthead'],
                          ['rail', 'Rail'],
                        ] as [FeedChromePreset, string][]).map(([preset, label]) => (
                          <button
                            key={preset}
                            onClick={() => setFeedChromePreset(preset)}
                            className={`px-3 py-1.5 rounded-cockpit border-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                              feedChromePreset === preset
                                ? 'border-oct-accent bg-oct-accent text-white'
                                : 'border-oct-border bg-oct-bg text-oct-muted hover:text-oct-text hover:border-oct-border-bright'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-oct-muted mt-2">
                        {feedChromePreset === 'terminal' && 'One dense status line. Rooms via ⌘K. Maximum feed space. (Default)'}
                        {feedChromePreset === 'masthead' && 'Vertical room rail with a large editorial room header.'}
                        {feedChromePreset === 'rail' && 'Icon rail, inline room dividers, bottom status bar. Densest.'}
                      </p>
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Split Screen Layout ]</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
                        Use the <strong className="text-oct-text">+</strong> button in a chat header to add up to 4 panes, and the layout button next to Help in the sidebar to resize and drag them. Choose how panes are arranged:
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {([
                          ['row', 'Single row'],
                          ['grid', 'Two rows'],
                        ] as [SplitLayout, string][]).map(([mode, label]) => (
                          <button
                            key={mode}
                            onClick={() => setSplitLayout(mode)}
                            className={`px-3 py-1.5 rounded-cockpit border-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                              splitLayout === mode
                                ? 'border-oct-accent bg-oct-accent text-white'
                                : 'border-oct-border bg-oct-bg text-oct-muted hover:text-oct-text'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Role Colors ]</h4>
                      <Toggle
                        value={roleColors}
                        onChange={setRoleColors}
                        label="Show Discord role colors on usernames"
                      />
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Mobile Zoom Scale ]</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
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
                          className="flex-1 h-1.5 bg-oct-bg rounded-cockpit appearance-none cursor-pointer accent-oct-accent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-cockpit [&::-webkit-slider-thumb]:bg-oct-accent"
                        />
                        <span className="text-xs font-mono text-oct-text w-10 text-right">{Math.round(mobileZoomScale * 100)}%</span>
                      </div>
                      <div className="flex justify-between mt-1.5">
                        <span className="text-[10px] font-mono text-oct-muted">50%</span>
                        <button
                          onClick={() => setMobileZoomScale(1)}
                          className="text-[10px] font-mono uppercase tracking-wide text-oct-accent hover:text-oct-accent-hover transition-colors duration-100"
                        >
                          Reset
                        </button>
                        <span className="text-[10px] font-mono text-oct-muted">150%</span>
                      </div>
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Contract Detection ]</h4>
                      <Toggle
                        value={contractDetection}
                        onChange={setContractDetection}
                        label="Detect SOL/EVM contract addresses in messages"
                      />
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Open in Discord App ]</h4>
                      <Toggle
                        value={openInDiscordApp}
                        onChange={setOpenInDiscordApp}
                        label="Clicking a channel badge opens the message directly in the Discord app"
                      />
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Open in Telegram App ]</h4>
                      <Toggle
                        value={openInTelegramApp}
                        onChange={setOpenInTelegramApp}
                        label="Clicking a TG channel badge opens the message directly in the Telegram app"
                      />
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Badge Click Action ]</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
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
                            className={`px-3 py-1.5 rounded-cockpit border-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                              badgeClickAction === action
                                ? 'border-oct-accent bg-oct-accent text-white'
                                : 'border-oct-border bg-oct-bg text-oct-muted hover:text-oct-text'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-oct-muted mt-2">
                        {badgeClickAction === 'discord' && 'Always opens the original message in Discord.'}
                        {badgeClickAction === 'platform' && 'Opens the contract in your configured trading platform if one is detected, otherwise falls back to Discord.'}
                        {badgeClickAction === 'both' && 'Opens the message in Discord and also opens the contract in your trading platform (if detected).'}
                      </p>
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">[ Chat / Send Messages ]</h4>
                      <Toggle
                        value={chattingEnabled}
                        onChange={setChattingEnabled}
                        label="Enable sending messages through OCT"
                      />
                      <div className="mt-3 p-2.5 sm:p-3 rounded-cockpit border-2 border-oct-flame bg-oct-flame/15">
                        <p className="text-[11px] sm:text-xs font-mono font-bold uppercase tracking-wide text-oct-flame mb-1">Warning: Detection Risk</p>
                        <p className="text-[10px] sm:text-[11px] text-oct-muted leading-relaxed">
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
