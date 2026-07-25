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

export default function HelpSection({ form }: { form: SettingsForm }) {
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
                  <h3 className="text-base sm:text-lg font-semibold text-white mb-1">Help & Features</h3>
                  <p className="text-sm text-discord-text-muted mb-6">
                    Everything you need to know about using OCT.
                  </p>

                  <div className="space-y-4">
                    {/* Getting Started */}
                    <details className="group bg-discord-sidebar rounded-lg" open>
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Getting Started</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <div className="flex gap-2 items-start">
                          <span className="text-discord-blurple font-bold mt-0.5">1.</span>
                          <span>Go to <strong className="text-white">Settings &gt; Guilds</strong> and enable the Discord servers you want to monitor.</span>
                        </div>
                        <div className="flex gap-2 items-start">
                          <span className="text-discord-blurple font-bold mt-0.5">2.</span>
                          <span>Click the <strong className="text-white">+</strong> button next to "Rooms" in the sidebar to create a room.</span>
                        </div>
                        <div className="flex gap-2 items-start">
                          <span className="text-discord-blurple font-bold mt-0.5">3.</span>
                          <span>Add channels from your enabled guilds into the room. A single room can aggregate channels from multiple servers.</span>
                        </div>
                        <div className="flex gap-2 items-start">
                          <span className="text-discord-blurple font-bold mt-0.5">4.</span>
                          <span>Messages from all added channels will stream into the room in real time.</span>
                        </div>
                      </div>
                    </details>

                    {/* Message Interactions */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Message Interactions</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2.5 text-sm text-discord-text">
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="font-medium text-white text-xs mb-1">Channel Badge</p>
                          <p className="text-discord-text-muted text-xs">Click the <strong className="text-discord-text">server / #channel</strong> badge on any message to jump to the original message in Discord. Configure whether it opens in the Discord app or browser in Settings &gt; General.</p>
                        </div>
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="font-medium text-white text-xs mb-1">Badge Click Action</p>
                          <p className="text-discord-text-muted text-xs">In Settings &gt; General, choose what badge clicks do: open in <strong className="text-discord-text">Discord</strong>, open in your <strong className="text-discord-text">trading platform</strong> (if a contract is detected), or <strong className="text-discord-text">both</strong>.</p>
                        </div>
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="font-medium text-white text-xs mb-1">Image Lightbox</p>
                          <p className="text-discord-text-muted text-xs">Click any image in a message to view it fullscreen. Press <strong className="text-discord-text">ESC</strong> to close.</p>
                        </div>
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="font-medium text-white text-xs mb-1">Compact Messages</p>
                          <p className="text-discord-text-muted text-xs">Messages from the same author within 5 minutes are grouped together. Hover over a compact message to see its timestamp.</p>
                        </div>
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="font-medium text-white text-xs mb-1">Right-Click Users</p>
                          <p className="text-discord-text-muted text-xs">Right-click a username to access the context menu where you can hide that user from the channel.</p>
                        </div>
                      </div>
                    </details>

                    {/* Focus Mode */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Focus Mode</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <p className="text-discord-text-muted">When a room has multiple channels, you can temporarily filter to a single channel:</p>
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Enter:</span> <span className="text-discord-text-muted">Click the</span> <Eye size={13} className="inline text-discord-text-muted mx-0.5" /> <span className="text-discord-text-muted">eye icon on any message to focus on that message's channel.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Active:</span> <span className="text-discord-text-muted">A "Focus Mode" badge appears in the channel header showing which channel you're filtering to. Only messages from that channel are displayed.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Exit:</span> <span className="text-discord-text-muted">Click the</span> <span className="text-white font-bold mx-0.5">&times;</span> <span className="text-discord-text-muted">on the badge to return to the full room view.</span></p>
                        </div>
                      </div>
                    </details>

                    {/* Chat / Quick Reply */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Chat / Quick Reply</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <p className="text-discord-text-muted">Send messages directly from the OCT dashboard without switching to Discord.</p>
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Enable:</span> <span className="text-discord-text-muted">Go to Settings &gt; General and turn on <strong className="text-discord-text">Chat / Send Messages</strong> (disabled by default).</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Channel Selector:</span> <span className="text-discord-text-muted">Use the <strong className="text-discord-text">#</strong> icon in the message bar to pick which channel to send to.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Quick Reply:</span> <span className="text-discord-text-muted">Click the reply icon on any message to instantly select that channel in the input bar.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Focus Mode:</span> <span className="text-discord-text-muted">When focus mode is active, the chat input automatically targets the focused channel.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Attachments:</span> <span className="text-discord-text-muted">Attach images and files via the <strong className="text-discord-text">+</strong> button or paste from clipboard (up to 10 files).</span></p>
                        </div>
                        <div className="px-3 py-2 bg-discord-red/10 border border-discord-red/20 rounded">
                          <p className="text-xs text-discord-red font-semibold mb-0.5">Detection Risk</p>
                          <p className="text-xs text-discord-text-muted">Sending messages through a third-party client increases the risk of Discord detecting and flagging your account. Read-only monitoring is passive and much safer.</p>
                        </div>
                      </div>
                    </details>

                    {/* Contract Detection */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Contract Detection</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <p className="text-discord-text-muted">OCT automatically detects Solana and EVM contract addresses in messages.</p>
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="text-xs"><span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#14f195]/20 text-[#14f195] mr-1">SOL</span> <span className="text-discord-text-muted">Solana addresses appear as green pills.</span></p>
                          <p className="text-xs"><span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#fee75c]/20 text-[#fee75c] mr-1">EVM</span> <span className="text-discord-text-muted">EVM addresses (0x...) appear as yellow pills.</span></p>
                          <p className="text-xs text-discord-text-muted">Click a contract to <strong className="text-discord-text">copy</strong> and/or <strong className="text-discord-text">open</strong> it in your configured trading platform (configurable in Settings &gt; Contracts).</p>
                        </div>
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="font-medium text-white text-xs mb-1">Contracts Dashboard</p>
                          <p className="text-discord-text-muted text-xs">Click <strong className="text-discord-text">Contracts</strong> in the sidebar to see a live feed of all detected contracts, searchable and filterable by chain.</p>
                        </div>
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="font-medium text-white text-xs mb-1">Auto-Open</p>
                          <p className="text-discord-text-muted text-xs">Enable "Auto-Open Highlighted Contracts" in Settings &gt; Contracts to automatically open a new tab when a highlighted user posts a contract.</p>
                        </div>
                      </div>
                    </details>

                    {/* User Highlighting */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">User Highlighting</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <p className="text-discord-text-muted">Track specific Discord users to never miss their messages.</p>
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Global:</span> <span className="text-discord-text-muted">Add user IDs in Settings &gt; Highlighted Users. These users are highlighted in all rooms.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Per-Room:</span> <span className="text-discord-text-muted">Edit a room (hover &gt; gear icon) &gt; Users tab to add room-specific highlights.</span></p>
                          <p className="text-xs text-discord-text-muted">Highlighted messages appear with a <span className="text-blue-400 font-medium">blue border</span>. Toast alerts pop up in the corner when they send a message.</p>
                        </div>
                      </div>
                    </details>

                    {/* Keyword Alerts */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Keyword Alerts</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <p className="text-discord-text-muted">Get alerted when messages match your keyword patterns.</p>
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Global:</span> <span className="text-discord-text-muted">Settings &gt; Keywords — matched in all rooms.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Per-Room:</span> <span className="text-discord-text-muted">Room config &gt; Keywords tab — only matched in that room.</span></p>
                          <p className="text-xs text-discord-text-muted">Three match modes: <strong className="text-discord-text">Contains</strong> (substring), <strong className="text-discord-text">Exact</strong> (whole word), and <strong className="text-discord-text">Regex</strong> (advanced patterns).</p>
                          <p className="text-xs text-discord-text-muted">Matched messages appear with an <span className="text-orange-400 font-medium">orange border</span>.</p>
                        </div>
                      </div>
                    </details>

                    {/* Room Configuration */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Room Configuration</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Edit/Delete:</span> <span className="text-discord-text-muted">Hover over a room in the sidebar to reveal the gear (edit) and trash (delete) icons.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Room Color:</span> <span className="text-discord-text-muted">Set a custom background color for the room in the config modal.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Disable Embeds:</span> <span className="text-discord-text-muted">Toggle embeds off for specific channels in the Channels tab of room config.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">User Filter:</span> <span className="text-discord-text-muted">In the Filter tab, add user IDs to only show messages from those users in the room.</span></p>
                        </div>
                      </div>
                    </details>

                    {/* User Management */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Hiding Users</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Hide:</span> <span className="text-discord-text-muted">Right-click any username &gt; "Hide user" to hide them from that specific channel.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Manage:</span> <span className="text-discord-text-muted">Click the hidden users icon in the channel header to view and unhide users.</span></p>
                        </div>
                      </div>
                    </details>

                    {/* Sounds & Notifications */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Sounds & Notifications</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-2 text-sm text-discord-text">
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="text-xs text-discord-text-muted">Three independent sound channels with individual volume controls:</p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Highlighted User:</span> <span className="text-discord-text-muted">Plays when a highlighted user sends a message.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Contract Alert:</span> <span className="text-discord-text-muted">Plays when a contract address is detected.</span></p>
                          <p className="text-xs"><span className="text-discord-blurple font-semibold">Keyword Match:</span> <span className="text-discord-text-muted">Plays when a keyword pattern matches.</span></p>
                          <p className="text-xs text-discord-text-muted">Upload custom sounds (MP3, WAV, OGG) or use built-in tones. Configure in Settings &gt; Sounds.</p>
                        </div>
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="font-medium text-white text-xs mb-1">Desktop Notifications</p>
                          <p className="text-xs text-discord-text-muted">Enable in Settings &gt; Sounds &amp; Notifications. Browser notifications appear when the tab is not focused and a highlighted user or keyword match is detected.</p>
                        </div>
                        <div className="px-3 py-2 bg-discord-dark rounded space-y-1.5">
                          <p className="font-medium text-white text-xs mb-1">Pushover</p>
                          <p className="text-xs text-discord-text-muted">Push notifications to your phone via Pushover when highlighted users post contracts. Configure in Settings &gt; Pushover.</p>
                        </div>
                      </div>
                    </details>

                    {/* Guild Colors */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Guild Colors</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 text-sm text-discord-text">
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="text-xs text-discord-text-muted">In Settings &gt; Guilds, assign a background color to each server. In rooms with multiple guilds, messages are color-coded so you can instantly tell which server a message came from.</p>
                        </div>
                      </div>
                    </details>

                    {/* DMs */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Direct Messages</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 text-sm text-discord-text">
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="text-xs text-discord-text-muted">DMs automatically appear in the sidebar under "Direct Messages" when you receive new messages. Click one to view the conversation.</p>
                        </div>
                      </div>
                    </details>

                    {/* Multiple Tokens */}
                    <details className="group bg-discord-sidebar rounded-lg">
                      <summary className="flex items-center gap-2 px-3 sm:px-4 py-2.5 sm:py-3 cursor-pointer select-none">
                        <svg className="w-4 h-4 text-discord-text-muted transition-transform group-open:rotate-90 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        <span className="text-sm font-semibold text-white">Multiple Accounts</span>
                      </summary>
                      <div className="px-3 sm:px-4 pb-3 sm:pb-4 text-sm text-discord-text">
                        <div className="px-3 py-2 bg-discord-dark rounded">
                          <p className="text-xs text-discord-text-muted">Add multiple Discord tokens in Settings &gt; Tokens to monitor channels across different accounts simultaneously. All guilds and channels from all tokens are available when creating rooms.</p>
                        </div>
                      </div>
                    </details>
                  </div>

                  <div className="mt-8 pt-6 border-t border-discord-divider">
                    <h4 className="text-sm font-semibold text-white mb-1">Backup & Restore</h4>
                    <p className="text-xs text-discord-text-muted mb-4">
                      Export your settings and rooms to a file, or import from a previous backup.{' '}
                      {isHostedMode
                        ? 'Sensitive keys (Discord tokens, Telegram credentials, Pushover keys) are never included in exports.'
                        : 'This includes your Discord tokens and Telegram credentials (API ID, hash, and session), so keep the file somewhere safe. Pushover keys are not included.'}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <button
                        onClick={handleExport}
                        disabled={exporting}
                        className="flex items-center gap-2 px-4 py-2 bg-discord-blurple hover:bg-discord-blurple-hover disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
                      >
                        <Download size={15} />
                        {exporting ? 'Exporting...' : 'Export Settings'}
                      </button>
                      <button
                        onClick={() => importFileRef.current?.click()}
                        disabled={importing}
                        className="flex items-center gap-2 px-4 py-2 bg-discord-sidebar hover:bg-discord-hover text-discord-text hover:text-white text-sm font-medium rounded border border-discord-divider transition-colors"
                      >
                        <Upload size={15} />
                        {importing ? 'Importing...' : 'Import Settings'}
                      </button>
                      <input
                        ref={importFileRef}
                        type="file"
                        accept=".json"
                        onChange={handleImportFile}
                        className="hidden"
                      />
                    </div>
                    {importError && (
                      <p className="mt-3 text-xs text-discord-red">{importError}</p>
                    )}
                    {importSuccess && (
                      <p className="mt-3 text-xs text-discord-green">Settings imported successfully.</p>
                    )}
                  </div>
                </div>
              </>
  );
}
