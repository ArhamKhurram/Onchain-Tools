import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../stores/appStore';
import type { SolPlatform, EvmPlatform, ContractClickAction, BadgeClickAction, KeywordPattern, KeywordMatchMode, SoundSettings, SoundType, SoundConfig, PushoverPriority, PushoverSound, PushoverTriggers, PushoverFilters, MessageDisplay, FeedChromePreset, SplitLayout, MissedRunnerConfig, MissedRunnerNotifyVia, ToastPosition, DiscordBotDmConfig, CallerTierEntry } from '../../types';
import type { Section } from './constants';
import { defaultSoundConfig, defaultRevivalSoundConfig, defaultTriggers, defaultFilters, defaultMissedRunner, defaultDiscordBotDm } from './constants';
import { apiBase, authedFetch } from './fields';

const FEED_CHROME_PRESETS: FeedChromePreset[] = ['terminal', 'masthead', 'rail'];

const normalizeFeedChromePreset = (value: unknown): FeedChromePreset =>
  FEED_CHROME_PRESETS.includes(value as FeedChromePreset) ? (value as FeedChromePreset) : 'terminal';

export function useSettingsForm() {
  const config = useAppStore((s) => s.config);
  const updateConfig = useAppStore((s) => s.updateConfig);
  const guilds = useAppStore((s) => s.guilds);
  const rooms = useAppStore((s) => s.rooms);
  const dmChannels = useAppStore((s) => s.dmChannels);
  const fetchGuilds = useAppStore((s) => s.fetchGuilds);
  const fetchDMChannels = useAppStore((s) => s.fetchDMChannels);
  const fetchConfig = useAppStore((s) => s.fetchConfig);
  const maskedTokens = useAppStore((s) => s.maskedTokens);
  const fetchMaskedTokens = useAppStore((s) => s.fetchMaskedTokens);
  const addToken = useAppStore((s) => s.addToken);
  const removeToken = useAppStore((s) => s.removeToken);
  const allMessages = useAppStore((s) => s.messages);
  const navigate = useNavigate();
  const settingsSection = useAppStore((s) => s.settingsSection);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const authStatus = useAppStore((s) => s.authStatus);
  const telegramDisconnect = useAppStore((s) => s.telegramDisconnect);
  const fetchRooms = useAppStore((s) => s.fetchRooms);

  const userNameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (config?.userNameCache) {
      for (const [id, name] of Object.entries(config.userNameCache)) {
        map.set(id, name);
      }
    }
    for (const msgs of Object.values(allMessages)) {
      for (const msg of msgs) {
        map.set(msg.author.id, msg.author.displayName);
      }
    }
    return map;
  }, [allMessages, config?.userNameCache]);

  const [section, setSection] = useState<Section>((settingsSection as Section) || 'tokens');
  const [globalUsers, setGlobalUsers] = useState<string[]>([]);
  const [newUserId, setNewUserId] = useState('');
  const [contractDetection, setContractDetection] = useState(true);
  const [guildColors, setGuildColors] = useState<Record<string, string>>({});
  const [dmColors, setDmColors] = useState<Record<string, string>>({});
  const [telegramColors, setTelegramColors] = useState<Record<string, string>>({});
  const [enabledGuilds, setEnabledGuilds] = useState<string[]>([]);
  const [guildSearch, setGuildSearch] = useState('');
  const [evmAddressColor, setEvmAddressColor] = useState('#fee75c');
  const [solAddressColor, setSolAddressColor] = useState('#14f195');
  const [openInDiscordApp, setOpenInDiscordApp] = useState(false);
  const [openInTelegramApp, setOpenInTelegramApp] = useState(false);
  const [messageSounds, setMessageSounds] = useState(false);
  const [soundSettings, setSoundSettings] = useState<SoundSettings>({
    highlight: { ...defaultSoundConfig },
    contractAlert: { ...defaultSoundConfig },
    keywordAlert: { ...defaultSoundConfig },
    fomoTrade: { ...defaultSoundConfig },
    pumpCallout: { ...defaultSoundConfig },
    revival: { ...defaultRevivalSoundConfig },
    breakout: { ...defaultSoundConfig },
  });
  const [channelSounds, setChannelSounds] = useState<Record<string, SoundConfig>>({});
  const [uploadingSoundType, setUploadingSoundType] = useState<SoundType | null>(null);
  const [uploadingChannelId, setUploadingChannelId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const channelFileInputRef = useRef<HTMLInputElement>(null);
  const [pushoverEnabled, setPushoverEnabled] = useState(false);
  const [pushoverAppToken, setPushoverAppToken] = useState('');
  const [pushoverUserKey, setPushoverUserKey] = useState('');
  const [pushoverPriority, setPushoverPriority] = useState<PushoverPriority>(1);
  const [pushoverSound, setPushoverSound] = useState<PushoverSound>('siren');
  const [pushoverTriggers, setPushoverTriggers] = useState<PushoverTriggers>({ ...defaultTriggers });
  const [pushoverFilters, setPushoverFilters] = useState<PushoverFilters>({ ...defaultFilters });
  const [discordBotDm, setDiscordBotDm] = useState<DiscordBotDmConfig>({ ...defaultDiscordBotDm, triggers: { ...defaultDiscordBotDm.triggers } });
  const [missedRunnerEnabled, setMissedRunnerEnabled] = useState(false);
  const [missedRunnerMultiplier, setMissedRunnerMultiplier] = useState(1.5);
  const [missedRunnerLookbackHours, setMissedRunnerLookbackHours] = useState(24);
  const [missedRunnerCooldownHours, setMissedRunnerCooldownHours] = useState(24);
  const [missedRunnerMinMcAtCall, setMissedRunnerMinMcAtCall] = useState('');
  const [missedRunnerNotifyVia, setMissedRunnerNotifyVia] = useState<MissedRunnerNotifyVia>('toast');
  const [missedRunnerTestAddress, setMissedRunnerTestAddress] = useState('');
  const [missedRunnerTestForce, setMissedRunnerTestForce] = useState(false);
  const [missedRunnerTestLoading, setMissedRunnerTestLoading] = useState(false);
  const [missedRunnerTestResult, setMissedRunnerTestResult] = useState<{
    ok: boolean;
    sent: boolean;
    message: string;
    diagnostics?: {
      multiplier?: number;
      minMultiplier?: number;
      mcAtCallDisplay?: string;
      mcNowDisplay?: string;
      wouldAlert?: boolean;
      blockReason?: string;
    };
  } | null>(null);
  const [solPlatform, setSolPlatform] = useState<SolPlatform>('axiom');
  const [evmPlatform, setEvmPlatform] = useState<EvmPlatform>('gmgn');
  const [customSolUrl, setCustomSolUrl] = useState('');
  const [customEvmUrl, setCustomEvmUrl] = useState('');
  const [contractClickAction, setContractClickAction] = useState<ContractClickAction>('copy_open');
  const [showFullContractAddress, setShowFullContractAddress] = useState(false);
  const [autoOpenHighlightedContracts, setAutoOpenHighlightedContracts] = useState(false);
  const [callerTiers, setCallerTiers] = useState<CallerTierEntry[]>([]);
  const [callerTierShowMuted, setCallerTierShowMuted] = useState(true);
  const [callerQualityRanking, setCallerQualityRanking] = useState(false);
  const [callerScoreExclusions, setCallerScoreExclusions] = useState<string[]>([]);
  const [signalConvergenceWindowMinutes, setSignalConvergenceWindowMinutes] = useState(30);
  const [globalKeywordPatterns, setGlobalKeywordPatterns] = useState<KeywordPattern[]>([]);
  const [keywordAlertsEnabled, setKeywordAlertsEnabled] = useState(true);
  const [desktopNotifications, setDesktopNotifications] = useState(false);
  const [toastAlertsEnabled, setToastAlertsEnabled] = useState(true);
  const [toastPosition, setToastPosition] = useState<ToastPosition>('top-right');
  const [mentionsUserEnabled, setMentionsUserEnabled] = useState(true);
  const [mentionsRoleEnabled, setMentionsRoleEnabled] = useState(true);
  const [mentionsHereEnabled, setMentionsHereEnabled] = useState(false);
  const [mentionsEveryoneEnabled, setMentionsEveryoneEnabled] = useState(false);
  const [badgeClickAction, setBadgeClickAction] = useState<BadgeClickAction>('discord');
  const [chattingEnabled, setChattingEnabled] = useState(false);
  const [messageDisplay, setMessageDisplay] = useState<MessageDisplay>('default');
  const [feedChromePreset, setFeedChromePreset] = useState<FeedChromePreset>('terminal');
  const [compactModeAvatars, setCompactModeAvatars] = useState(true);
  const [roleColors, setRoleColors] = useState(true);
  const [mobileZoomScale, setMobileZoomScale] = useState(1);
  const [splitLayout, setSplitLayout] = useState<SplitLayout>('row');
  const [newKeywordPattern, setNewKeywordPattern] = useState('');
  const [newKeywordMatchMode, setNewKeywordMatchMode] = useState<KeywordMatchMode>('includes');
  const [newKeywordLabel, setNewKeywordLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [showNewToken, setShowNewToken] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [addingToken, setAddingToken] = useState(false);
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxySaving, setProxySaving] = useState(false);
  const [proxySaved, setProxySaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showTelegramSetup, setShowTelegramSetup] = useState(false);

  useEffect(() => {
    fetchGuilds();
    fetchDMChannels();
    fetchConfig();
    fetchMaskedTokens();
  }, [fetchGuilds, fetchDMChannels, fetchConfig, fetchMaskedTokens]);

  useEffect(() => {
    if (config) {
      setGlobalUsers(config.globalHighlightedUsers);
      setContractDetection(config.contractDetection);
      setGuildColors(config.guildColors ?? {});
      setDmColors(config.dmColors ?? {});
      setTelegramColors(config.telegramColors ?? {});
      setEnabledGuilds(config.enabledGuilds ?? []);
      setEvmAddressColor(config.evmAddressColor ?? '#fee75c');
      setSolAddressColor(config.solAddressColor ?? '#14f195');
      setOpenInDiscordApp(config.openInDiscordApp ?? false);
      setOpenInTelegramApp(config.openInTelegramApp ?? false);
      setMessageSounds(config.messageSounds ?? false);
      if (config.soundSettings) {
        setSoundSettings({
          highlight: { ...defaultSoundConfig, ...config.soundSettings.highlight },
          contractAlert: { ...defaultSoundConfig, ...config.soundSettings.contractAlert },
          keywordAlert: { ...defaultSoundConfig, ...config.soundSettings.keywordAlert },
          fomoTrade: { ...defaultSoundConfig, ...config.soundSettings.fomoTrade },
          pumpCallout: { ...defaultSoundConfig, ...config.soundSettings.pumpCallout },
          revival: { ...defaultRevivalSoundConfig, ...config.soundSettings.revival },
          breakout: { ...defaultSoundConfig, ...config.soundSettings.breakout },
        });
      }
      setChannelSounds(config.channelSounds ?? {});
      setPushoverEnabled(config.pushover?.enabled ?? false);
      setPushoverAppToken(config.pushover?.appToken ?? '');
      setPushoverUserKey(config.pushover?.userKey ?? '');
      setPushoverPriority(config.pushover?.priority ?? 1);
      setPushoverSound(config.pushover?.sound ?? 'siren');
      setPushoverTriggers({ ...defaultTriggers, ...config.pushover?.triggers });
      setDiscordBotDm({
        enabled: config.discordBotDm?.enabled ?? defaultDiscordBotDm.enabled,
        triggers: { ...defaultDiscordBotDm.triggers, ...config.discordBotDm?.triggers },
      });
      setPushoverFilters(config.pushover?.filters ?? { ...defaultFilters });
      const mr = { ...defaultMissedRunner, ...config.missedRunner };
      setMissedRunnerEnabled(mr.enabled);
      setMissedRunnerMultiplier(mr.minMultiplier);
      setMissedRunnerLookbackHours(mr.lookbackHours);
      setMissedRunnerCooldownHours(mr.cooldownHours);
      setMissedRunnerMinMcAtCall(mr.minMcAtCall != null ? String(mr.minMcAtCall) : '');
      setMissedRunnerNotifyVia(mr.notifyVia ?? (config.pushover?.triggers?.missedRunner ? 'pushover' : 'toast'));
      setSolPlatform(config.contractLinkTemplates?.solPlatform ?? 'axiom');
      setEvmPlatform(config.contractLinkTemplates?.evmPlatform ?? 'gmgn');
      setCustomSolUrl(config.contractLinkTemplates?.sol ?? '');
      setCustomEvmUrl(config.contractLinkTemplates?.evm ?? '');
      setContractClickAction(config.contractClickAction ?? 'copy_open');
      setShowFullContractAddress(config.showFullContractAddress ?? false);
      setAutoOpenHighlightedContracts(config.autoOpenHighlightedContracts ?? false);
      setCallerTiers(config.callerTiers ?? []);
      setCallerTierShowMuted(config.callerTierShowMuted ?? true);
      setCallerQualityRanking(config.callerQualityRanking ?? false);
      setCallerScoreExclusions(config.callerScoreExclusions ?? []);
      setSignalConvergenceWindowMinutes(config.signalConvergenceWindowMinutes ?? 30);
      setGlobalKeywordPatterns(config.globalKeywordPatterns ?? []);
      setKeywordAlertsEnabled(config.keywordAlertsEnabled ?? true);
      setDesktopNotifications(config.desktopNotifications ?? false);
      setToastAlertsEnabled(config.toastAlertsEnabled ?? true);
      setToastPosition(config.toastPosition ?? 'top-right');
      setMentionsUserEnabled(config.mentionsUserEnabled ?? true);
      setMentionsRoleEnabled(config.mentionsRoleEnabled ?? true);
      setMentionsHereEnabled(config.mentionsHereEnabled ?? false);
      setMentionsEveryoneEnabled(config.mentionsEveryoneEnabled ?? false);
      setBadgeClickAction(config.badgeClickAction ?? 'discord');
      setChattingEnabled(config.chattingEnabled ?? false);
      setMessageDisplay(config.messageDisplay ?? 'default');
      setFeedChromePreset(normalizeFeedChromePreset(config.feedChromePreset));
      setCompactModeAvatars(config.compactModeAvatars ?? true);
      setRoleColors(config.roleColors ?? true);
      setMobileZoomScale(config.mobileZoomScale ?? 1);
      setSplitLayout(config.splitLayout === 'grid' ? 'grid' : 'row');
      setProxyUrl(config.discordProxyUrl ?? '');
    }
  }, [config]);

  const hasUnsavedChanges = useMemo(() => {
    if (!config) return false;
    const arraysEqual = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
    const kpEqual = (a: KeywordPattern[], b: KeywordPattern[]) =>
      a.length === b.length && a.every((v, i) => v.pattern === b[i].pattern && v.matchMode === b[i].matchMode && v.label === b[i].label);
    const objEqual = (a: Record<string, string>, b: Record<string, string>) => {
      const aKeys = Object.keys(a), bKeys = Object.keys(b);
      return aKeys.length === bKeys.length && aKeys.every((k) => a[k] === b[k]);
    };

    const savedMissedRunner = { ...defaultMissedRunner, ...config.missedRunner };
    const savedPushoverTriggers = { ...defaultTriggers, ...(config.pushover?.triggers ?? {}) };
    const savedDiscordBotDm = {
      enabled: config.discordBotDm?.enabled ?? defaultDiscordBotDm.enabled,
      triggers: { ...defaultDiscordBotDm.triggers, ...(config.discordBotDm?.triggers ?? {}) },
    };
    const savedPushoverFilters = { ...defaultFilters, ...(config.pushover?.filters ?? {}) };

    return (
      !arraysEqual(globalUsers, config.globalHighlightedUsers) ||
      contractDetection !== config.contractDetection ||
      !objEqual(guildColors, config.guildColors ?? {}) ||
      !objEqual(dmColors, config.dmColors ?? {}) ||
      !objEqual(telegramColors, config.telegramColors ?? {}) ||
      !arraysEqual(enabledGuilds, config.enabledGuilds ?? []) ||
      evmAddressColor !== (config.evmAddressColor ?? '#fee75c') ||
      solAddressColor !== (config.solAddressColor ?? '#14f195') ||
      openInDiscordApp !== (config.openInDiscordApp ?? false) ||
      openInTelegramApp !== (config.openInTelegramApp ?? false) ||
      messageSounds !== (config.messageSounds ?? false) ||
      JSON.stringify(soundSettings) !== JSON.stringify(config.soundSettings ? {
        highlight: { ...defaultSoundConfig, ...config.soundSettings.highlight },
        contractAlert: { ...defaultSoundConfig, ...config.soundSettings.contractAlert },
        keywordAlert: { ...defaultSoundConfig, ...config.soundSettings.keywordAlert },
        fomoTrade: { ...defaultSoundConfig, ...config.soundSettings.fomoTrade },
        pumpCallout: { ...defaultSoundConfig, ...config.soundSettings.pumpCallout },
        revival: { ...defaultRevivalSoundConfig, ...config.soundSettings.revival },
        breakout: { ...defaultSoundConfig, ...config.soundSettings.breakout },
      } : { highlight: defaultSoundConfig, contractAlert: defaultSoundConfig, keywordAlert: defaultSoundConfig, fomoTrade: defaultSoundConfig, pumpCallout: defaultSoundConfig, revival: defaultRevivalSoundConfig, breakout: defaultSoundConfig }) ||
      JSON.stringify(channelSounds) !== JSON.stringify(config.channelSounds ?? {}) ||
      pushoverEnabled !== (config.pushover?.enabled ?? false) ||
      pushoverAppToken !== (config.pushover?.appToken ?? '') ||
      pushoverUserKey !== (config.pushover?.userKey ?? '') ||
      pushoverPriority !== (config.pushover?.priority ?? 1) ||
      pushoverSound !== (config.pushover?.sound ?? 'siren') ||
      JSON.stringify(pushoverTriggers) !== JSON.stringify(savedPushoverTriggers) ||
      JSON.stringify(pushoverFilters) !== JSON.stringify(savedPushoverFilters) ||
      JSON.stringify(discordBotDm) !== JSON.stringify(savedDiscordBotDm) ||
      missedRunnerEnabled !== savedMissedRunner.enabled ||
      missedRunnerMultiplier !== savedMissedRunner.minMultiplier ||
      missedRunnerLookbackHours !== savedMissedRunner.lookbackHours ||
      missedRunnerCooldownHours !== savedMissedRunner.cooldownHours ||
      missedRunnerMinMcAtCall !== (savedMissedRunner.minMcAtCall != null ? String(savedMissedRunner.minMcAtCall) : '') ||
      missedRunnerNotifyVia !== savedMissedRunner.notifyVia ||
      solPlatform !== (config.contractLinkTemplates?.solPlatform ?? 'axiom') ||
      evmPlatform !== (config.contractLinkTemplates?.evmPlatform ?? 'gmgn') ||
      customSolUrl !== (config.contractLinkTemplates?.sol ?? '') ||
      customEvmUrl !== (config.contractLinkTemplates?.evm ?? '') ||
      contractClickAction !== (config.contractClickAction ?? 'copy_open') ||
      showFullContractAddress !== (config.showFullContractAddress ?? false) ||
      autoOpenHighlightedContracts !== (config.autoOpenHighlightedContracts ?? false) ||
      signalConvergenceWindowMinutes !== (config.signalConvergenceWindowMinutes ?? 30) ||
      !kpEqual(globalKeywordPatterns, config.globalKeywordPatterns ?? []) ||
      keywordAlertsEnabled !== (config.keywordAlertsEnabled ?? true) ||
      desktopNotifications !== (config.desktopNotifications ?? false) ||
      toastAlertsEnabled !== (config.toastAlertsEnabled ?? true) ||
      toastPosition !== (config.toastPosition ?? 'top-right') ||
      mentionsUserEnabled !== (config.mentionsUserEnabled ?? true) ||
      mentionsRoleEnabled !== (config.mentionsRoleEnabled ?? true) ||
      mentionsHereEnabled !== (config.mentionsHereEnabled ?? false) ||
      mentionsEveryoneEnabled !== (config.mentionsEveryoneEnabled ?? false) ||
      badgeClickAction !== (config.badgeClickAction ?? 'discord') ||
      chattingEnabled !== (config.chattingEnabled ?? false) ||
      messageDisplay !== (config.messageDisplay ?? 'default') ||
      feedChromePreset !== normalizeFeedChromePreset(config.feedChromePreset) ||
      compactModeAvatars !== (config.compactModeAvatars ?? true) ||
      roleColors !== (config.roleColors ?? true) ||
      mobileZoomScale !== (config.mobileZoomScale ?? 1) ||
      splitLayout !== (config.splitLayout === 'grid' ? 'grid' : 'row') ||
      callerTierShowMuted !== (config.callerTierShowMuted ?? true) ||
      callerQualityRanking !== (config.callerQualityRanking ?? false) ||
      JSON.stringify(callerTiers) !== JSON.stringify(config.callerTiers ?? []) ||
      JSON.stringify(callerScoreExclusions) !== JSON.stringify(config.callerScoreExclusions ?? [])
    );
  }, [callerTiers, callerTierShowMuted, callerQualityRanking, callerScoreExclusions, config, globalUsers, contractDetection, guildColors, dmColors, telegramColors, enabledGuilds, evmAddressColor, solAddressColor,
    openInDiscordApp, openInTelegramApp, messageSounds, soundSettings, channelSounds, pushoverEnabled, pushoverAppToken, pushoverUserKey, pushoverPriority, pushoverSound, pushoverTriggers, pushoverFilters, discordBotDm,
    missedRunnerEnabled, missedRunnerMultiplier, missedRunnerLookbackHours, missedRunnerCooldownHours, missedRunnerMinMcAtCall, missedRunnerNotifyVia,
    solPlatform, evmPlatform, customSolUrl, customEvmUrl, contractClickAction, showFullContractAddress, autoOpenHighlightedContracts, signalConvergenceWindowMinutes,
    globalKeywordPatterns, keywordAlertsEnabled, desktopNotifications, toastAlertsEnabled, toastPosition, mentionsUserEnabled, mentionsRoleEnabled, mentionsHereEnabled, mentionsEveryoneEnabled, badgeClickAction, chattingEnabled, messageDisplay, feedChromePreset, compactModeAvatars, roleColors, mobileZoomScale, splitLayout]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  const guardNavigation = useCallback((action: () => void) => {
    if (hasUnsavedChanges) {
      if (window.confirm('You have unsaved changes. Are you sure you want to leave without saving?')) {
        action();
      }
    } else {
      action();
    }
  }, [hasUnsavedChanges]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await updateConfig({
        globalHighlightedUsers: globalUsers,
        contractDetection,
        guildColors,
        dmColors,
        telegramColors,
        enabledGuilds,
        evmAddressColor,
        solAddressColor,
        openInDiscordApp,
        openInTelegramApp,
        messageSounds,
        soundSettings,
        channelSounds,
        pushover: { enabled: pushoverEnabled, appToken: pushoverAppToken, userKey: pushoverUserKey, priority: pushoverPriority, sound: pushoverSound, triggers: pushoverTriggers, filters: pushoverFilters },
        discordBotDm,
        missedRunner: {
          enabled: missedRunnerEnabled,
          minMultiplier: missedRunnerMultiplier,
          lookbackHours: missedRunnerLookbackHours,
          cooldownHours: missedRunnerCooldownHours,
          notifyVia: missedRunnerNotifyVia,
          ...(missedRunnerMinMcAtCall.trim() ? { minMcAtCall: Number(missedRunnerMinMcAtCall) } : {}),
        },
        contractLinkTemplates: { evm: customEvmUrl, sol: customSolUrl, solPlatform, evmPlatform },
        contractClickAction,
        showFullContractAddress,
        autoOpenHighlightedContracts,
        callerTiers,
        callerTierShowMuted,
        callerQualityRanking,
        callerScoreExclusions,
        signalConvergenceWindowMinutes,
        globalKeywordPatterns,
        keywordAlertsEnabled,
        desktopNotifications,
        toastAlertsEnabled,
        toastPosition,
        mentionsUserEnabled,
        mentionsRoleEnabled,
        mentionsHereEnabled,
        mentionsEveryoneEnabled,
        badgeClickAction,
        chattingEnabled,
        messageDisplay,
        feedChromePreset,
        compactModeAvatars,
        roleColors,
        mobileZoomScale,
        splitLayout,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save settings';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  };

  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleMissedRunnerTest = async () => {
    setMissedRunnerTestLoading(true);
    setMissedRunnerTestResult(null);
    try {
      const res = await authedFetch(`${apiBase}/alerts/missed-runner/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: missedRunnerTestAddress.trim(),
          force: missedRunnerTestForce,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMissedRunnerTestResult({
          ok: false,
          sent: false,
          message: res.status === 429
            ? (data.error ?? 'Rate limited — wait a minute and try again.')
            : (data.error ?? `Test failed (${res.status})`),
        });
        return;
      }
      setMissedRunnerTestResult(data);
    } catch (err: unknown) {
      setMissedRunnerTestResult({
        ok: false,
        sent: false,
        message: err instanceof Error ? err.message : 'Test failed',
      });
    } finally {
      setMissedRunnerTestLoading(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await authedFetch(`${apiBase}/config/export`);
      if (!res.ok) throw new Error('Export failed');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `oct-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert('Failed to export settings.');
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(false);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.config || typeof data.config !== 'object') {
        throw new Error('Invalid settings file: missing config.');
      }
      const res = await authedFetch(`${apiBase}/config/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: data.config, rooms: data.rooms }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Import failed');
      }
      await fetchConfig();
      await fetchRooms();
      setImportSuccess(true);
      setTimeout(() => setImportSuccess(false), 3000);
    } catch (err: any) {
      setImportError(err.message || 'Failed to import settings.');
    } finally {
      setImporting(false);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  const addGlobalUser = () => {
    const id = newUserId.trim();
    if (id && !globalUsers.includes(id)) {
      setGlobalUsers((prev) => [...prev, id]);
      setNewUserId('');
    }
  };

  const removeGlobalUser = (userId: string) => {
    setGlobalUsers((prev) => prev.filter((u) => u !== userId));
  };

  const addKeyword = () => {
    if (!newKeywordPattern.trim()) return;
    setGlobalKeywordPatterns((prev) => [
      ...prev,
      { pattern: newKeywordPattern.trim(), matchMode: newKeywordMatchMode, label: newKeywordLabel.trim() || undefined },
    ]);
    setNewKeywordPattern('');
    setNewKeywordLabel('');
  };

  return {
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
    discordBotDm, setDiscordBotDm,
    setPushoverFilters, missedRunnerEnabled, setMissedRunnerEnabled, missedRunnerMultiplier, setMissedRunnerMultiplier, missedRunnerLookbackHours,
    setMissedRunnerLookbackHours, missedRunnerCooldownHours, setMissedRunnerCooldownHours, missedRunnerMinMcAtCall, setMissedRunnerMinMcAtCall, missedRunnerNotifyVia,
    setMissedRunnerNotifyVia, missedRunnerTestAddress, setMissedRunnerTestAddress, missedRunnerTestForce, setMissedRunnerTestForce, missedRunnerTestLoading,
    setMissedRunnerTestLoading, missedRunnerTestResult, setMissedRunnerTestResult, solPlatform, setSolPlatform, evmPlatform,
    setEvmPlatform, customSolUrl, setCustomSolUrl, customEvmUrl, setCustomEvmUrl, contractClickAction,
    setContractClickAction, showFullContractAddress, setShowFullContractAddress, autoOpenHighlightedContracts, setAutoOpenHighlightedContracts,
    callerTiers, setCallerTiers, callerTierShowMuted, setCallerTierShowMuted, callerQualityRanking, setCallerQualityRanking,
    callerScoreExclusions, setCallerScoreExclusions, signalConvergenceWindowMinutes,
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
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
