import { Key, Search, Plus, Trash2, Eye, EyeOff, Volume2, Upload, Play, Users, Shield, Tag, Zap, Settings2, ArrowLeft, HelpCircle, Bell, PanelLeftOpen, Send, Download, AlertTriangle, AtSign } from 'lucide-react';
import type { SolPlatform, EvmPlatform, ContractClickAction, BadgeClickAction, KeywordPattern, KeywordMatchMode, SoundSettings, SoundType, SoundConfig, PushoverPriority, PushoverSound, PushoverTriggers, PushoverFilters, MessageDisplay, SplitLayout, MissedRunnerConfig, MissedRunnerNotifyVia, ToastPosition } from '../../../types';
import { PUSHOVER_SOUNDS, TOAST_POSITIONS, MISSED_RUNNER_NOTIFY_OPTIONS } from '../../../types';
import { requestNotificationPermission } from '../../../utils/desktopNotification';
import { previewSound, previewPreset, PRESET_SOUNDS } from '../../../utils/notificationSound';
import ColorPickerWithAlpha from '../../ColorPickerWithAlpha';
import BulkAddUsers from '../../BulkAddUsers';
import TelegramSetup from '../../TelegramSetup';
import { isHostedMode } from '../../../lib/supabase';
import { isClientGatewayMode } from '../../../discord/clientGateway';
import { Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

export default function UsersSection({ form }: { form: SettingsForm }) {
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
    handleExport, handleImportFile, addGlobalUser, addGlobalUsers, removeGlobalUser, addKeyword,
  } = form;
  return (
              <>
                <div>
                  <h3 className="font-display text-2xl sm:text-3xl tracking-tight text-oct-text mb-1">Global Highlighted Users</h3>
                  <p className="text-xs sm:text-sm text-oct-muted mb-3 sm:mb-4">
                    These users will be highlighted in all rooms. Use Discord user IDs or Telegram @usernames.
                  </p>
                  <div className="flex gap-2 mb-4">
                    <input
                      type="text"
                      value={newUserId}
                      onChange={(e) => setNewUserId(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addGlobalUser()}
                      placeholder="User ID or @telegram_username"
                      className="flex-1 oct-input px-3 py-2 text-sm"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      data-form-type="other"
                    />
                    <button
                      onClick={addGlobalUser}
                      className="oct-btn-primary px-3 py-2 text-sm"
                    >
                      <Plus size={16} />
                    </button>
                  </div>

                  <BulkAddUsers
                    existing={globalUsers}
                    onAdd={addGlobalUsers}
                    variant="settings"
                    noun="global highlighted users"
                  />

                  <div className="space-y-1">
                    {globalUsers.length === 0 && (
                      <p className="text-sm text-oct-muted text-center py-4">
                        No global highlighted users.
                      </p>
                    )}
                    {globalUsers.map((uid) => {
                      const isTgUser = uid.startsWith('@');
                      return (
                      <div key={uid} className="flex items-center justify-between gap-2 px-2 sm:px-3 py-2 rounded-oct border border-oct-border bg-oct-surface-raised oct-row-hover">
                        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                          {isTgUser && <Send size={12} className="text-oct-accent shrink-0" />}
                          <span className={`text-xs sm:text-sm truncate font-mono ${isTgUser ? 'text-oct-accent' : 'text-oct-text'}`}>{uid}</span>
                          {!isTgUser && userNameMap.has(uid) && (
                            <span className="text-[11px] sm:text-xs text-oct-muted shrink-0">{userNameMap.get(uid)}</span>
                          )}
                        </div>
                        <button
                          onClick={() => removeGlobalUser(uid)}
                          className="text-oct-muted hover:text-oct-flame shrink-0"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      );
                    })}
                  </div>
                </div>
              </>
  );
}
