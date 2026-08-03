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

export default function ContractsSection({ form }: { form: SettingsForm }) {
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
                  <h3 className="font-display text-xl sm:text-2xl tracking-tight text-oct-text mb-4">Contracts</h3>

                  <div className="space-y-5">
                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">Contract Click Action</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
                        What happens when you click a contract address in chat.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {([
                          ['copy', 'Copy'],
                          ['copy_open', 'Copy + Open'],
                          ['open', 'Open Only'],
                        ] as [ContractClickAction, string][]).map(([action, label]) => (
                          <button
                            key={action}
                            onClick={() => setContractClickAction(action)}
                            className={`px-3 py-1.5 rounded-cockpit border-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                              contractClickAction === action
                                ? 'border-oct-accent bg-oct-accent text-white'
                                : 'border-oct-border bg-oct-bg text-oct-muted hover:text-oct-text hover:border-oct-border-bright'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">Display Full Contract Address</h4>
                      <Toggle
                        value={showFullContractAddress}
                        onChange={setShowFullContractAddress}
                        label="Show the full contract address in chat and the contract list instead of the shortened form (0x1234...abcd)"
                      />
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">Trading Platform</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
                        Choose which trading platform opens when you click a contract address.
                      </p>
                      <div className="space-y-3">
                        <div className="px-3 py-2.5 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised">
                          <label className="block font-mono text-[11px] uppercase tracking-wide text-oct-muted mb-1.5">SOL Platform</label>
                          <div className="flex flex-wrap gap-1.5">
                            {(['axiom', 'padre', 'bloom', 'gmgn', 'custom'] as SolPlatform[]).map((p) => (
                              <button
                                key={p}
                                onClick={() => setSolPlatform(p)}
                                className={`px-3 py-1.5 rounded-cockpit border-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                                  solPlatform === p
                                    ? 'border-oct-accent bg-oct-accent text-white'
                                    : 'border-oct-border bg-oct-bg text-oct-muted hover:text-oct-text hover:border-oct-border-bright'
                                }`}
                              >
                                {p === 'axiom' ? 'Axiom' : p === 'padre' ? 'Padre' : p === 'bloom' ? 'Bloom' : p === 'gmgn' ? 'GMGN' : 'Custom'}
                              </button>
                            ))}
                          </div>
                          {solPlatform === 'custom' && (
                            <input
                              type="text"
                              value={customSolUrl}
                              onChange={(e) => setCustomSolUrl(e.target.value)}
                              placeholder="https://example.com/token/{address}"
                              className="w-full mt-2 px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent font-mono"
                            />
                          )}
                        </div>
                        <div className="px-3 py-2.5 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised">
                          <label className="block font-mono text-[11px] uppercase tracking-wide text-oct-muted mb-1.5">EVM Platform</label>
                          <div className="flex flex-wrap gap-1.5">
                            {(['gmgn', 'bloom', 'custom'] as EvmPlatform[]).map((p) => (
                              <button
                                key={p}
                                onClick={() => setEvmPlatform(p)}
                                className={`px-3 py-1.5 rounded-cockpit border-2 font-mono text-xs font-bold uppercase tracking-wide transition-colors duration-100 ${
                                  evmPlatform === p
                                    ? 'border-oct-accent bg-oct-accent text-white'
                                    : 'border-oct-border bg-oct-bg text-oct-muted hover:text-oct-text hover:border-oct-border-bright'
                                }`}
                              >
                                {p === 'gmgn' ? 'GMGN' : p === 'bloom' ? 'Bloom' : 'Custom'}
                              </button>
                            ))}
                          </div>
                          {evmPlatform === 'custom' && (
                            <input
                              type="text"
                              value={customEvmUrl}
                              onChange={(e) => setCustomEvmUrl(e.target.value)}
                              placeholder="https://example.com/token/{address}"
                              className="w-full mt-2 px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text placeholder:text-oct-muted/60 focus:outline-none focus:border-oct-accent font-mono"
                            />
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">Auto-Open Highlighted Contracts</h4>
                      <Toggle
                        value={autoOpenHighlightedContracts}
                        onChange={setAutoOpenHighlightedContracts}
                        label="Automatically open a new tab when a highlighted user posts a contract address"
                      />
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">Signal Convergence Window</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
                        When a contract appears in your feed and a tracked FOMO user buys the same token within this window, a convergence alert fires.
                      </p>
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          min={1}
                          max={240}
                          value={signalConvergenceWindowMinutes}
                          onChange={(e) => setSignalConvergenceWindowMinutes(Math.max(1, Math.min(240, Number(e.target.value) || 30)))}
                          className="w-20 px-3 py-2 rounded-cockpit bg-oct-bg border-2 border-oct-border text-sm text-oct-text focus:outline-none focus:border-oct-accent font-mono"
                        />
                        <span className="text-xs sm:text-sm text-oct-muted">minutes (default 30)</span>
                      </div>
                    </div>

                    <div className="brutal-card p-3 sm:p-4">
                      <h4 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-2">Address Colors</h4>
                      <p className="text-xs sm:text-sm text-oct-muted mb-3">
                        Customize highlight colors for detected contract addresses by chain type.
                      </p>
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised">
                          <ColorPickerWithAlpha
                            value={evmAddressColor}
                            onChange={(c) => setEvmAddressColor(c)}
                            defaultColor="#fee75c"
                            showTextInput
                          />
                          <span className="text-xs sm:text-sm text-oct-text flex-1">EVM (0x...)</span>
                          {evmAddressColor !== '#fee75c' && (
                            <button onClick={() => setEvmAddressColor('#fee75c')} className="font-mono text-[11px] uppercase tracking-wide text-oct-muted hover:text-oct-accent shrink-0">Reset</button>
                          )}
                        </div>
                        <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 rounded-cockpit border-2 border-oct-border bg-oct-surface-raised">
                          <ColorPickerWithAlpha
                            value={solAddressColor}
                            onChange={(c) => setSolAddressColor(c)}
                            defaultColor="#14f195"
                            showTextInput
                          />
                          <span className="text-xs sm:text-sm text-oct-text flex-1">SOL</span>
                          {solAddressColor !== '#14f195' && (
                            <button onClick={() => setSolAddressColor('#14f195')} className="font-mono text-[11px] uppercase tracking-wide text-oct-muted hover:text-oct-accent shrink-0">Reset</button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
  );
}
