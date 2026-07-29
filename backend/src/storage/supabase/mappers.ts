import type { AppConfig, Room, ChannelRef, KeywordPattern } from '../../discord/types.js';

export const CACHE_TTL_MS = 10_000; // 10 seconds

export const DEFAULT_SETTINGS: Omit<AppConfig, 'discordTokens' | 'rooms'> = {
  globalHighlightedUsers: [],
  contractDetection: true,
  guildColors: {},
  dmColors: {},
  enabledGuilds: [],
  evmAddressColor: '#fee75c',
  solAddressColor: '#14f195',
  openInDiscordApp: false,
  openInTelegramApp: false,
  hiddenUsers: {},
  callerTiers: [],
  callerTierShowMuted: true,
  callerQualityRanking: false,
  messageSounds: false,
  soundSettings: {
    highlight: { enabled: true, volume: 80, useCustom: false },
    contractAlert: { enabled: true, volume: 80, useCustom: false },
    keywordAlert: { enabled: true, volume: 80, useCustom: false },
  },
  channelSounds: {},
  pushover: {
    enabled: false, appToken: '', userKey: '',
    priority: 1 as const, sound: 'siren' as const,
    triggers: { highlightedUser: false, highlightedUserContract: true, contract: false, keyword: false, signalConvergence: false, missedRunner: false },
    filters: { userIds: [], channelIds: [], guildIds: [] },
  },
  missedRunner: {
    enabled: false,
    minMultiplier: 1.5,
    lookbackHours: 24,
    cooldownHours: 24,
    notifyVia: 'toast',
  },
  contractLinkTemplates: {
    evm: 'https://gmgn.ai/base/token/{address}',
    sol: 'https://axiom.trade/t/{address}?chain=sol',
    solPlatform: 'axiom',
    evmPlatform: 'gmgn',
  },
  contractClickAction: 'copy_open',
  showFullContractAddress: false,
  autoOpenHighlightedContracts: false,
  signalConvergenceWindowMinutes: 30,
  globalKeywordPatterns: [],
  keywordAlertsEnabled: true,
  desktopNotifications: false,
  toastAlertsEnabled: true,
  toastPosition: 'top-right',
  mentionsUserEnabled: true,
  mentionsRoleEnabled: true,
  mentionsHereEnabled: false,
  mentionsEveryoneEnabled: false,
  badgeClickAction: 'discord',
  userNameCache: {},
  chattingEnabled: false,
  messageDisplay: 'default',
  compactModeAvatars: true,
  roleColors: true,
  mobileZoomScale: 1,
  splitLayout: 'row',
  paneRoomIds: [],
  paneLocks: [],
  gridMirror: false,
  seenAnnouncements: [],
  telegramColors: {},
};

export interface HighlightRow {
  room_id: string | null;
  match_type: string;
  value: string;
  color: string | null;
}

export interface KeywordRow {
  room_id: string | null;
  pattern: string;
  match_mode: string;
  label: string | null;
  enabled: boolean;
}

export function highlightRowsToApp(rows: HighlightRow[]): Pick<Room, 'highlightedUsers' | 'highlightedUserColors'> {
  const highlightedUsers: string[] = [];
  const highlightedUserColors: Record<string, string> = {};
  for (const row of rows) {
    const key = row.match_type === 'username' ? `@${row.value}` : row.value;
    highlightedUsers.push(key);
    if (row.color) highlightedUserColors[key] = row.color;
  }
  return { highlightedUsers, highlightedUserColors };
}

export function keywordRowsToApp(rows: KeywordRow[]): KeywordPattern[] {
  return rows
    .filter((row) => row.enabled)
    .map((row) => ({
      pattern: row.pattern,
      matchMode: row.match_mode as KeywordPattern['matchMode'],
      label: row.label ?? undefined,
      isRegex: row.match_mode === 'regex',
    }));
}

export function appHighlightsToRows(
  userId: string,
  roomId: string | null,
  users: string[],
  colors: Record<string, string> = {},
) {
  return users.map((entry) => {
    const isUsername = entry.startsWith('@');
    return {
      user_id: userId,
      room_id: roomId,
      match_type: isUsername ? 'username' : 'user_id',
      value: isUsername ? entry.slice(1) : entry,
      color: colors[entry] ?? null,
    };
  });
}

export function appKeywordsToRows(userId: string, roomId: string | null, patterns: KeywordPattern[]) {
  return patterns.map((pattern) => ({
    user_id: userId,
    room_id: roomId,
    pattern: pattern.pattern,
    match_mode: pattern.matchMode ?? (pattern.isRegex ? 'regex' : 'includes'),
    label: pattern.label ?? null,
    enabled: true,
  }));
}

export function dbRoomToAppRoom(
  row: any,
  channels: ChannelRef[],
  highlights: HighlightRow[],
  keywords: KeywordRow[],
): Room {
  const { highlightedUsers, highlightedUserColors } = highlightRowsToApp(highlights);
  return {
    id: row.id,
    name: row.name,
    channels,
    highlightedUsers,
    filteredUsers: row.filtered_users ?? [],
    filterEnabled: row.filter_enabled ?? false,
    color: row.color ?? null,
    keywordPatterns: keywordRowsToApp(keywords),
    highlightMode: row.highlight_mode ?? 'background',
    highlightedUserColors,
  };
}
