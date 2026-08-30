import { useState } from 'react';
import { Key, Search, Plus, Trash2, Eye, EyeOff, Volume2, Upload, Play, Users, Shield, Tag, Zap, Settings2, ArrowLeft, HelpCircle, Bell, PanelLeftOpen, Send, Download, AlertTriangle, AtSign, BookOpen, ExternalLink } from 'lucide-react';
import type { SolPlatform, EvmPlatform, ContractClickAction, BadgeClickAction, KeywordPattern, KeywordMatchMode, SoundSettings, SoundType, SoundConfig, PushoverPriority, PushoverSound, PushoverTriggers, PushoverFilters, MessageDisplay, SplitLayout, MissedRunnerConfig, MissedRunnerNotifyVia, ToastPosition } from '../../../types';
import { PUSHOVER_SOUNDS, TOAST_POSITIONS, MISSED_RUNNER_NOTIFY_OPTIONS } from '../../../types';
import { requestNotificationPermission } from '../../../utils/desktopNotification';
import { previewSound, previewPreset, PRESET_SOUNDS } from '../../../utils/notificationSound';
import ColorPickerWithAlpha from '../../ColorPickerWithAlpha';
import TelegramSetup from '../../TelegramSetup';
import { isHostedMode } from '../../../lib/supabase';
import { isClientGatewayMode } from '../../../discord/clientGateway';
import { USER_DOCS_URL } from '../../../lib/links';
import { Toggle } from '../fields';
import type { SettingsForm } from '../useSettingsForm';

const panelClass = 'rounded-oct border border-oct-border bg-oct-surface-raised p-3';
const stepKickerClass = 'font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-accent mt-0.5 shrink-0';
const inlineKickerClass = 'font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-oct-accent';
const subHeadingClass = 'font-mono text-xs font-bold uppercase tracking-[0.15em] text-oct-text mb-1';

export default function HelpSection({ form }: { form: SettingsForm }) {
  const {
    config, updateConfig, guilds, rooms, dmChannels, fetchGuilds,
    fetchDMChannels, fetchConfig, maskedTokens, fetchMaskedTokens, addToken, removeToken,
    navigate, settingsSection, sidebarCollapsed, toggleSidebar, authStatus,
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

  const [activeSection, setActiveSection] = useState('getting-started');

  const sections = [
    {
      id: 'getting-started',
      title: 'Getting Started',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <div className="flex gap-3 items-start">
            <span className={stepKickerClass}>[ 01 ]</span>
            <span>Go to <strong className="text-oct-text">Settings &gt; Guilds</strong> and enable the Discord servers you want to monitor.</span>
          </div>
          <div className="flex gap-3 items-start">
            <span className={stepKickerClass}>[ 02 ]</span>
            <span>Click the <strong className="text-oct-text">+</strong> button next to "Rooms" in the sidebar to create a room.</span>
          </div>
          <div className="flex gap-3 items-start">
            <span className={stepKickerClass}>[ 03 ]</span>
            <span>Add channels from your enabled guilds into the room. A single room can aggregate channels from multiple servers.</span>
          </div>
          <div className="flex gap-3 items-start">
            <span className={stepKickerClass}>[ 04 ]</span>
            <span>Messages from all added channels will stream into the room in real time.</span>
          </div>
        </div>
      ),
    },
    {
      id: 'message-interactions',
      title: 'Message Interactions',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <div className={panelClass}>
            <p className={subHeadingClass}>Channel Badge</p>
            <p className="text-oct-muted text-xs">Click the <strong className="text-oct-text">server / #channel</strong> badge on any message to jump to the original message in Discord. Configure whether it opens in the Discord app or browser in Settings &gt; General.</p>
          </div>
          <div className={panelClass}>
            <p className={subHeadingClass}>Badge Click Action</p>
            <p className="text-oct-muted text-xs">In Settings &gt; General, choose what badge clicks do: open in <strong className="text-oct-text">Discord</strong>, open in your <strong className="text-oct-text">trading platform</strong> (if a contract is detected), or <strong className="text-oct-text">both</strong>.</p>
          </div>
          <div className={panelClass}>
            <p className={subHeadingClass}>Image Lightbox</p>
            <p className="text-oct-muted text-xs">Click any image in a message to view it fullscreen. Press <strong className="text-oct-text">ESC</strong> to close.</p>
          </div>
          <div className={panelClass}>
            <p className={subHeadingClass}>Compact Messages</p>
            <p className="text-oct-muted text-xs">Messages from the same author within 5 minutes are grouped together. Hover over a compact message to see its timestamp.</p>
          </div>
          <div className={panelClass}>
            <p className={subHeadingClass}>Right-Click Users</p>
            <p className="text-oct-muted text-xs">Right-click a username to access the context menu where you can hide that user from the channel.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'focus-mode',
      title: 'Focus Mode',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <p className="text-oct-muted">When a room has multiple channels, you can temporarily filter to a single channel:</p>
          <div className={`${panelClass} space-y-1.5`}>
            <p className="text-xs"><span className={inlineKickerClass}>Enter:</span> <span className="text-oct-muted">Click the</span> <Eye size={13} className="inline text-oct-muted mx-0.5" /> <span className="text-oct-muted">eye icon on any message to focus on that message's channel.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Active:</span> <span className="text-oct-muted">A "Focus Mode" badge appears in the channel header showing which channel you're filtering to. Only messages from that channel are displayed.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Exit:</span> <span className="text-oct-muted">Click the</span> <span className="text-oct-text font-bold mx-0.5">&times;</span> <span className="text-oct-muted">on the badge to return to the full room view.</span></p>
          </div>
        </div>
      ),
    },
    {
      id: 'chat-quick-reply',
      title: 'Chat / Quick Reply',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <p className="text-oct-muted">Send messages directly from the OCT dashboard without switching to Discord.</p>
          <div className={`${panelClass} space-y-1.5`}>
            <p className="text-xs"><span className={inlineKickerClass}>Enable:</span> <span className="text-oct-muted">Go to Settings &gt; General and turn on <strong className="text-oct-text">Chat / Send Messages</strong> (disabled by default).</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Channel Selector:</span> <span className="text-oct-muted">Use the <strong className="text-oct-text">#</strong> icon in the message bar to pick which channel to send to.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Quick Reply:</span> <span className="text-oct-muted">Click the reply icon on any message to instantly select that channel in the input bar.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Focus Mode:</span> <span className="text-oct-muted">When focus mode is active, the chat input automatically targets the focused channel.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Attachments:</span> <span className="text-oct-muted">Attach images and files via the <strong className="text-oct-text">+</strong> button or paste from clipboard (up to 10 files).</span></p>
          </div>
          <div className="rounded-oct border border-oct-flame/60 bg-oct-flame/10 p-3">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-oct-flame mb-1">Detection Risk</p>
            <p className="text-xs text-oct-muted">Sending messages through a third-party client increases the risk of Discord detecting and flagging your account. Read-only monitoring is passive and much safer.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'contract-detection',
      title: 'Contract Detection',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <p className="text-oct-muted">OCT automatically detects Solana and EVM contract addresses in messages.</p>
          <div className={`${panelClass} space-y-1.5`}>
            <p className="text-xs"><span className="inline-flex items-center rounded-oct-sm border border-oct-green/60 bg-oct-green/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-green mr-1">SOL</span> <span className="text-oct-muted">Solana addresses appear as green pills.</span></p>
            <p className="text-xs"><span className="inline-flex items-center rounded-oct-sm border border-oct-yellow/60 bg-oct-yellow/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-oct-yellow mr-1">EVM</span> <span className="text-oct-muted">EVM addresses (0x...) appear as yellow pills.</span></p>
            <p className="text-xs text-oct-muted">Click a contract to <strong className="text-oct-text">copy</strong> and/or <strong className="text-oct-text">open</strong> it in your configured trading platform (configurable in Settings &gt; Contracts).</p>
          </div>
          <div className={panelClass}>
            <p className={subHeadingClass}>Contracts Dashboard</p>
            <p className="text-oct-muted text-xs">Click <strong className="text-oct-text">Contracts</strong> in the sidebar to see a live feed of all detected contracts, searchable and filterable by chain.</p>
          </div>
          <div className={panelClass}>
            <p className={subHeadingClass}>Auto-Open</p>
            <p className="text-oct-muted text-xs">Enable "Auto-Open Highlighted Contracts" in Settings &gt; Contracts to automatically open a new tab when a highlighted user posts a contract.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'user-highlighting',
      title: 'User Highlighting',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <p className="text-oct-muted">Track specific Discord users to never miss their messages.</p>
          <div className={`${panelClass} space-y-1.5`}>
            <p className="text-xs"><span className={inlineKickerClass}>Global:</span> <span className="text-oct-muted">Add user IDs in Settings &gt; Highlighted Users. These users are highlighted in all rooms.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Per-Room:</span> <span className="text-oct-muted">Edit a room (hover &gt; gear icon) &gt; Users tab to add room-specific highlights.</span></p>
            <p className="text-xs text-oct-muted">Highlighted messages appear with a <span className="text-oct-text font-medium">coloured border</span> — pick the colour per user above. Toast alerts pop up in the corner when they send a message.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'keyword-alerts',
      title: 'Keyword Alerts',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <p className="text-oct-muted">Get alerted when messages match your keyword patterns.</p>
          <div className={`${panelClass} space-y-1.5`}>
            <p className="text-xs"><span className={inlineKickerClass}>Global:</span> <span className="text-oct-muted">Settings &gt; Keywords — matched in all rooms.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Per-Room:</span> <span className="text-oct-muted">Room config &gt; Keywords tab — only matched in that room.</span></p>
            <p className="text-xs text-oct-muted">Three match modes: <strong className="text-oct-text">Contains</strong> (substring), <strong className="text-oct-text">Exact</strong> (whole word), and <strong className="text-oct-text">Regex</strong> (advanced patterns).</p>
            <p className="text-xs text-oct-muted">Matched messages appear with an <span className="text-oct-yellow font-medium">orange border</span>.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'room-configuration',
      title: 'Room Configuration',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <div className={`${panelClass} space-y-1.5`}>
            <p className="text-xs"><span className={inlineKickerClass}>Edit/Delete:</span> <span className="text-oct-muted">Hover over a room in the sidebar to reveal the gear (edit) and trash (delete) icons.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Room Color:</span> <span className="text-oct-muted">Set a custom background color for the room in the config modal.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Disable Embeds:</span> <span className="text-oct-muted">Toggle embeds off for specific channels in the Channels tab of room config.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>User Filter:</span> <span className="text-oct-muted">In the Filter tab, add user IDs to only show messages from those users in the room.</span></p>
          </div>
        </div>
      ),
    },
    {
      id: 'hiding-users',
      title: 'Hiding Users',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <div className={`${panelClass} space-y-1.5`}>
            <p className="text-xs"><span className={inlineKickerClass}>Hide:</span> <span className="text-oct-muted">Right-click any username &gt; "Hide user" to hide them from that specific channel.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Manage:</span> <span className="text-oct-muted">Click the hidden users icon in the channel header to view and unhide users.</span></p>
          </div>
        </div>
      ),
    },
    {
      id: 'sounds-notifications',
      title: 'Sounds & Notifications',
      body: (
        <div className="space-y-3 text-sm text-oct-text">
          <div className={`${panelClass} space-y-1.5`}>
            <p className="text-xs text-oct-muted">Three independent sound channels with individual volume controls:</p>
            <p className="text-xs"><span className={inlineKickerClass}>Highlighted User:</span> <span className="text-oct-muted">Plays when a highlighted user sends a message.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Contract Alert:</span> <span className="text-oct-muted">Plays when a contract address is detected.</span></p>
            <p className="text-xs"><span className={inlineKickerClass}>Keyword Match:</span> <span className="text-oct-muted">Plays when a keyword pattern matches.</span></p>
            <p className="text-xs text-oct-muted">Upload custom sounds (MP3, WAV, OGG) or use built-in tones. Configure in Settings &gt; Sounds.</p>
          </div>
          <div className={`${panelClass} space-y-1.5`}>
            <p className={subHeadingClass}>Desktop Notifications</p>
            <p className="text-xs text-oct-muted">Enable in Settings &gt; Sounds &amp; Notifications. Browser notifications appear when the tab is not focused and a highlighted user or keyword match is detected.</p>
          </div>
          <div className={`${panelClass} space-y-1.5`}>
            <p className={subHeadingClass}>Pushover</p>
            <p className="text-xs text-oct-muted">Push notifications to your phone via Pushover when highlighted users post contracts. Configure in Settings &gt; Pushover.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'guild-colors',
      title: 'Guild Colors',
      body: (
        <div className="text-sm text-oct-text">
          <div className={panelClass}>
            <p className="text-xs text-oct-muted">In Settings &gt; Guilds, assign a background color to each server. In rooms with multiple guilds, messages are color-coded so you can instantly tell which server a message came from.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'direct-messages',
      title: 'Direct Messages',
      body: (
        <div className="text-sm text-oct-text">
          <div className={panelClass}>
            <p className="text-xs text-oct-muted">DMs automatically appear in the sidebar under "Direct Messages" when you receive new messages. Click one to view the conversation.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'multiple-accounts',
      title: 'Multiple Accounts',
      body: (
        <div className="text-sm text-oct-text">
          <div className={panelClass}>
            <p className="text-xs text-oct-muted">Add multiple Discord tokens in Settings &gt; Tokens to monitor channels across different accounts simultaneously. All guilds and channels from all tokens are available when creating rooms.</p>
          </div>
        </div>
      ),
    },
  ];

  return (
              <>
                <div>
                  <h3 className="font-display text-2xl sm:text-3xl tracking-tight text-oct-text mb-1">Help &amp; Features</h3>
                  <p className="text-sm text-oct-muted mb-4">
                    Everything you need to know about using OCT.
                  </p>

                  {/* This in-app manual is the short version. The full guide is
                      a separate site and used to be linked from nowhere. */}
                  <a
                    href={USER_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 mb-6 rounded-oct border border-oct-accent/40 bg-oct-accent-dim px-3.5 py-2.5 text-oct-accent transition-colors hover:border-oct-accent hover:bg-oct-accent/15"
                  >
                    <BookOpen size={15} className="shrink-0" />
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em]">
                      Full user guide
                    </span>
                    <ExternalLink size={13} className="shrink-0 opacity-70" />
                  </a>

                  <div className="flex flex-col lg:flex-row gap-4">
                    <nav className="shrink-0 lg:w-56 rounded-oct border border-oct-border bg-oct-surface overflow-hidden">
                      <p className="px-3 py-2 border-b border-oct-border font-mono text-xs uppercase tracking-[0.2em] text-oct-muted">[ MANUAL ]</p>
                      <div className="flex lg:flex-col overflow-x-auto">
                        {sections.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setActiveSection(s.id)}
                            className={`shrink-0 lg:w-full text-left px-3 py-2 border-l-2 font-mono text-[11px] uppercase tracking-[0.15em] whitespace-nowrap transition-colors duration-100 ${
                              activeSection === s.id
                                ? 'border-oct-accent bg-oct-accent-dim text-oct-accent'
                                : 'border-transparent text-oct-muted hover:bg-oct-surface-raised hover:text-oct-text'
                            }`}
                          >
                            {s.title}
                          </button>
                        ))}
                      </div>
                    </nav>

                    <div className="flex-1 min-w-0 oct-card p-4 sm:p-5">
                      {sections.map((s) => (
                        activeSection === s.id ? (
                          <div key={s.id}>
                            <p className="font-mono text-xs uppercase tracking-[0.2em] text-oct-muted mb-4">[ {s.title} ]</p>
                            {s.body}
                          </div>
                        ) : null
                      ))}
                    </div>
                  </div>

                  <div className="mt-8 pt-6 border-t border-oct-border">
                    <h4 className="font-mono text-xs uppercase tracking-[0.2em] text-oct-muted mb-2">[ BACKUP &amp; RESTORE ]</h4>
                    <p className="text-xs text-oct-muted mb-4">
                      Export your settings and rooms to a file, or import from a previous backup.{' '}
                      {isHostedMode
                        ? 'Sensitive keys (Discord tokens, Telegram credentials, Pushover keys) are never included in exports.'
                        : 'This includes your Discord tokens and Telegram credentials (API ID, hash, and session), so keep the file somewhere safe. Pushover keys are not included.'}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <button
                        onClick={handleExport}
                        disabled={exporting}
                        className="oct-btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm"
                      >
                        <Download size={15} />
                        {exporting ? 'Exporting...' : 'Export Settings'}
                      </button>
                      <button
                        onClick={() => importFileRef.current?.click()}
                        disabled={importing}
                        className="oct-icon-btn px-4 py-2 text-sm"
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
                      <p className="mt-3 text-xs text-oct-flame">{importError}</p>
                    )}
                    {importSuccess && (
                      <p className="mt-3 text-xs text-oct-green">Settings imported successfully.</p>
                    )}
                  </div>
                </div>
              </>
  );
}
