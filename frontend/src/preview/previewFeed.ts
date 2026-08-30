// Preview-feed seed data + live stream generator.
//
// This powers the "Continue without a token" onboarding path: a brand-new user
// who has NOT connected Discord watches a realistic contract feed flow before
// being asked to paste anything. It flips "trust us, then get value" into "get
// value, then trust us" — the #1 activation fix from the activation playbook.
//
// Preview mode is available to every hosted user at runtime, so this seed
// lives on its own and never touches the backend. Everything here is PURE and
// deterministic given a seq/now, which is what makes it unit-testable.

import type {
  Room,
  AppConfig,
  GuildInfo,
  FrontendMessage,
  ContractEntry,
  CallerTierEntry,
} from '../types';

// ---------------------------------------------------------------------------
// IDs — stable so React keys and pane wiring behave across re-seeds.
// ---------------------------------------------------------------------------

export const PREVIEW_GUILD_SOL = 'preview-guild-sol';
export const PREVIEW_GUILD_PUMP = 'preview-guild-pump';

const CH_SOL_ALPHA = 'preview-ch-sol-alpha';
const CH_SOL_WHALES = 'preview-ch-sol-whales';
const CH_PUMP_RUNNERS = 'preview-ch-pump-runners';

export const PREVIEW_ROOM_ALPHA = 'preview-room-alpha';
export const PREVIEW_ROOM_RUNNERS = 'preview-room-runners';

// ---------------------------------------------------------------------------
// Callers — each with a tier so the feed shows caller "bands" (trusted vs
// normal), one of the things the playbook wants a newcomer to see immediately.
// ---------------------------------------------------------------------------

interface PreviewCaller {
  id: string;
  username: string;
  displayName: string;
  tier: CallerTierEntry['tier'];
}

const CALLERS: Record<string, PreviewCaller> = {
  cooker: { id: '800000000000000201', username: 'cooked.sol', displayName: 'cooked', tier: 'trusted' },
  frank: { id: '800000000000000202', username: 'frankdegods', displayName: 'Frank', tier: 'trusted' },
  mia: { id: '800000000000000203', username: 'mia.eth', displayName: 'Mia', tier: 'normal' },
  ansem: { id: '800000000000000204', username: 'blknoiz06', displayName: 'Ansem', tier: 'trusted' },
  jito: { id: '800000000000000205', username: 'jito_maxi', displayName: 'Jito Maxi', tier: 'normal' },
  scope: { id: '800000000000000206', username: 'scope.bnb', displayName: 'Scope', tier: 'normal' },
};

const author = (c: PreviewCaller): FrontendMessage['author'] => ({
  id: c.id,
  username: c.username,
  displayName: c.displayName,
  avatar: null,
});

// ---------------------------------------------------------------------------
// Contract addresses — realistic shapes (base58 SOL, hex EVM). These are not
// live tokens; they exist only to make the feed feel real during onboarding.
// ---------------------------------------------------------------------------

interface PreviewToken {
  address: string;
  chain: 'sol' | 'evm';
  evmChain?: string;
  symbol: string;
  name: string;
}

const TOKENS: PreviewToken[] = [
  { address: 'Gd5J8kD4xTq9v2ZzHnQ2rWc7YpF3sN6mLbX1aUeQ9wRt', chain: 'sol', symbol: 'WIFHAT', name: 'dogwifhat' },
  { address: 'H7pQ2mNvK9sXdR4tJ6wLbZ3cYaF8gU1nQeV5rT2hMxA', chain: 'sol', symbol: 'PONKE', name: 'Ponke' },
  { address: '9xQeWvG8x2yT3nZ1rPq6mLcK7dF4sB5hN2uJ8aReV0t', chain: 'sol', symbol: 'MOONPIG', name: 'Moon Pig' },
  { address: '4kD9pL2mQ7vX8nR3tJ5wZ1cY6aF0gB4hU2sN7eReQ9w', chain: 'sol', symbol: 'RETARDIO', name: 'Retardio' },
  { address: '0xb695559b26bb2c9703ef1935c37aeae9526bab07', chain: 'evm', evmChain: 'base', symbol: 'BRETT', name: 'Brett' },
  { address: '0x912ce59144191c1204e64559fe8253a0e49e6548', chain: 'evm', evmChain: 'bsc', symbol: 'ANDY', name: 'Andy' },
];

// ---------------------------------------------------------------------------
// Guilds
// ---------------------------------------------------------------------------

export const PREVIEW_GUILDS: GuildInfo[] = [
  {
    id: PREVIEW_GUILD_SOL,
    name: 'Solana Alpha',
    icon: null,
    channels: [
      { id: CH_SOL_ALPHA, name: 'alpha-calls', type: 0 },
      { id: CH_SOL_WHALES, name: 'whale-watch', type: 0 },
    ],
  },
  {
    id: PREVIEW_GUILD_PUMP,
    name: 'Pump Runners',
    icon: null,
    channels: [{ id: CH_PUMP_RUNNERS, name: 'runners', type: 0 }],
  },
];

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export const PREVIEW_ROOMS: Room[] = [
  {
    id: PREVIEW_ROOM_ALPHA,
    name: 'Solana Alpha',
    channels: [
      { guildId: PREVIEW_GUILD_SOL, channelId: CH_SOL_ALPHA, guildName: 'Solana Alpha', channelName: 'alpha-calls' },
      { guildId: PREVIEW_GUILD_SOL, channelId: CH_SOL_WHALES, guildName: 'Solana Alpha', channelName: 'whale-watch' },
    ],
    highlightedUsers: [CALLERS.cooker.id, CALLERS.frank.id, CALLERS.ansem.id],
    filteredUsers: [],
    filterEnabled: false,
    color: '#14263a',
  },
  {
    id: PREVIEW_ROOM_RUNNERS,
    name: 'Pump Runners',
    channels: [
      { guildId: PREVIEW_GUILD_PUMP, channelId: CH_PUMP_RUNNERS, guildName: 'Pump Runners', channelName: 'runners' },
    ],
    highlightedUsers: [CALLERS.ansem.id],
    filteredUsers: [],
    filterEnabled: false,
    color: '#2a1a3a',
  },
];

const CALLER_TIERS: CallerTierEntry[] = Object.values(CALLERS)
  .filter((c) => c.tier !== 'normal')
  .map((c) => ({ key: `discord:${c.id}`, displayName: c.displayName, tier: c.tier }));

// ---------------------------------------------------------------------------
// Config — a generic AppConfig base (dozens of required fields, formerly the
// retired VITE_DEMO_MODE build's DEMO_CONFIG); buildPreviewConfig overrides
// the preview-specific fields on top of it.
// ---------------------------------------------------------------------------

const PREVIEW_BASE_CONFIG: AppConfig = {
  discordTokens: [],
  rooms: [],
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
  messageSounds: false,
  soundSettings: {
    highlight: { enabled: true, volume: 80, useCustom: false },
    contractAlert: { enabled: true, volume: 80, useCustom: false },
    keywordAlert: { enabled: true, volume: 80, useCustom: false },
    fomoTrade: { enabled: true, volume: 80, useCustom: false },
    pumpCallout: { enabled: true, volume: 80, useCustom: false },
    revival: { enabled: true, volume: 100, useCustom: false, repeatUntilDismissed: true },
    breakout: { enabled: true, volume: 80, useCustom: false },
  },
  pushover: { enabled: false, appToken: '', userKey: '', priority: 0, sound: 'pushover', triggers: { highlightedUser: false, highlightedUserContract: false, contract: false, keyword: false, signalConvergence: false, missedRunner: false }, filters: { userIds: [], channelIds: [], guildIds: [] } },
  missedRunner: { enabled: false, minMultiplier: 1.5, lookbackHours: 24, cooldownHours: 24, notifyVia: 'toast' },
  contractLinkTemplates: { evm: '', sol: '', solPlatform: 'axiom', evmPlatform: 'gmgn' },
  contractClickAction: 'copy_open',
  showFullContractAddress: false,
  autoOpenHighlightedContracts: false,
  signalConvergenceWindowMinutes: 30,
  globalKeywordPatterns: [
    { pattern: 'airdrop', matchMode: 'includes', label: 'airdrop' },
  ],
  keywordAlertsEnabled: true,
  desktopNotifications: false,
  toastAlertsEnabled: true,
  toastPosition: 'top-right',
  mentionsUserEnabled: true,
  mentionsRoleEnabled: true,
  mentionsHereEnabled: false,
  mentionsEveryoneEnabled: false,
  badgeClickAction: 'discord',
  channelSounds: {},
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

export function buildPreviewConfig(): AppConfig {
  const base: AppConfig = JSON.parse(JSON.stringify(PREVIEW_BASE_CONFIG));
  return {
    ...base,
    rooms: PREVIEW_ROOMS,
    discordTokens: [],
    globalHighlightedUsers: [CALLERS.cooker.id, CALLERS.frank.id, CALLERS.ansem.id],
    enabledGuilds: [PREVIEW_GUILD_SOL, PREVIEW_GUILD_PUMP],
    guildColors: {
      [PREVIEW_GUILD_SOL]: '#14263a',
      [PREVIEW_GUILD_PUMP]: '#2a1a3a',
    },
    callerTiers: CALLER_TIERS,
    paneRoomIds: [],
  };
}

// ---------------------------------------------------------------------------
// Message + contract factories
// ---------------------------------------------------------------------------

function isoAgo(now: number, secondsAgo: number): string {
  return new Date(now - secondsAgo * 1000).toISOString();
}

function mcDisplay(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd >= 10_000_000 ? 0 : 1)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${usd}`;
}

function makeMessage(
  id: string,
  channelId: string,
  guildId: string,
  channelName: string,
  guildName: string,
  caller: PreviewCaller,
  content: string,
  timestamp: string,
  overrides: Partial<FrontendMessage> = {},
): FrontendMessage {
  return {
    id,
    channelId,
    guildId,
    channelName,
    guildName,
    author: author(caller),
    content,
    timestamp,
    attachments: [],
    embeds: [],
    isHighlighted: false,
    hasContractAddress: false,
    contractAddresses: [],
    mentions: {},
    ...overrides,
  };
}

/** A single "call" — a highlighted CA message plus its enriched contract row. */
function makeCall(opts: {
  id: string;
  roomId: string;
  channelId: string;
  channelName: string;
  caller: PreviewCaller;
  token: PreviewToken;
  mcapUsd: number;
  content: string;
  timestamp: string;
  reactions?: FrontendMessage['reactions'];
}): { message: FrontendMessage; contract: ContractEntry; roomIds: string[] } {
  const { id, roomId, channelId, channelName, caller, token, mcapUsd, content, timestamp, reactions } = opts;
  const guildId = roomId === PREVIEW_ROOM_RUNNERS ? PREVIEW_GUILD_PUMP : PREVIEW_GUILD_SOL;
  const guildName = roomId === PREVIEW_ROOM_RUNNERS ? 'Pump Runners' : 'Solana Alpha';

  const message = makeMessage(id, channelId, guildId, channelName, guildName, caller, content, timestamp, {
    isHighlighted: caller.tier === 'trusted',
    hasContractAddress: true,
    contractAddresses: [token.address],
    reactions,
  });

  const contract: ContractEntry = {
    address: token.address,
    chain: token.chain,
    evmChain: token.evmChain,
    authorId: caller.id,
    authorName: caller.displayName,
    channelId,
    channelName,
    guildId,
    guildName,
    roomIds: [roomId],
    messageId: id,
    timestamp,
    source: 'discord',
    firstSeen: true,
    tokenName: token.name,
    tokenSymbol: token.symbol,
    fdvAtCall: mcapUsd,
    fdvAtCallDisplay: mcDisplay(mcapUsd),
    firstCallerName: caller.displayName,
    firstCallMcapUsd: mcapUsd,
    firstCallAt: timestamp,
    enrichmentSource: 'rick',
    enrichedAt: timestamp,
  };

  return { message, contract, roomIds: [roomId] };
}

// ---------------------------------------------------------------------------
// Seed — the initial history a user sees the instant preview opens.
// ---------------------------------------------------------------------------

export interface PreviewSeed {
  rooms: Room[];
  config: AppConfig;
  guilds: GuildInfo[];
  messages: Record<string, FrontendMessage[]>;
  contracts: ContractEntry[];
  activeRoomId: string;
  paneRoomIds: string[];
}

/**
 * Build the full initial preview state. `now` is injectable for deterministic
 * tests; defaults to the current time so timestamps read as "just now".
 */
export function buildPreviewSeed(now: number = Date.now()): PreviewSeed {
  const alpha: FrontendMessage[] = [];
  const runners: FrontendMessage[] = [];
  const contracts: ContractEntry[] = [];

  // A little chatter so the feed isn't wall-to-wall calls.
  alpha.push(
    makeMessage('pv-a1', CH_SOL_ALPHA, PREVIEW_GUILD_SOL, 'alpha-calls', 'Solana Alpha', CALLERS.mia, 'gm — SOL holding 180 nicely, risk on today', isoAgo(now, 1680)),
    makeMessage('pv-a2', CH_SOL_ALPHA, PREVIEW_GUILD_SOL, 'alpha-calls', 'Solana Alpha', CALLERS.jito, 'volume rotating back into memes, watch the majors bleed', isoAgo(now, 1520)),
  );

  const calls: Array<Parameters<typeof makeCall>[0]> = [
    {
      id: 'pv-c1', roomId: PREVIEW_ROOM_ALPHA, channelId: CH_SOL_ALPHA, channelName: 'alpha-calls',
      caller: CALLERS.cooker, token: TOKENS[1], mcapUsd: 420_000,
      content: `$${TOKENS[1].symbol} looking primed, clean holders and liq locked\n${TOKENS[1].address}`,
      timestamp: isoAgo(now, 1320), reactions: [{ emoji: { id: null, name: '🔥' }, count: 12 }, { emoji: { id: null, name: '🚀' }, count: 6 }],
    },
    {
      id: 'pv-c2', roomId: PREVIEW_ROOM_ALPHA, channelId: CH_SOL_WHALES, channelName: 'whale-watch',
      caller: CALLERS.frank, token: TOKENS[0], mcapUsd: 2_400_000,
      content: `whale just aped 900 SOL into $${TOKENS[0].symbol} — ${TOKENS[0].address}`,
      timestamp: isoAgo(now, 960), reactions: [{ emoji: { id: null, name: '🐋' }, count: 21 }],
    },
    {
      id: 'pv-c3', roomId: PREVIEW_ROOM_ALPHA, channelId: CH_SOL_ALPHA, channelName: 'alpha-calls',
      caller: CALLERS.ansem, token: TOKENS[3], mcapUsd: 88_000,
      content: `low cap degen play, ${mcDisplay(88_000)} mcap. NFA\n${TOKENS[3].address}`,
      timestamp: isoAgo(now, 540), reactions: [{ emoji: { id: null, name: '👀' }, count: 9 }],
    },
    {
      id: 'pv-c4', roomId: PREVIEW_ROOM_RUNNERS, channelId: CH_PUMP_RUNNERS, channelName: 'runners',
      caller: CALLERS.scope, token: TOKENS[4], mcapUsd: 6_100_000,
      content: `$${TOKENS[4].symbol} on Base breaking out, ${mcDisplay(6_100_000)} and climbing\n${TOKENS[4].address}`,
      timestamp: isoAgo(now, 300),
    },
  ];

  for (const c of calls) {
    const { message, contract } = makeCall(c);
    if (c.roomId === PREVIEW_ROOM_RUNNERS) runners.push(message);
    else alpha.push(message);
    contracts.push(contract);
  }

  alpha.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  runners.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  // Newest contract first, matching how addContract prepends.
  contracts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    rooms: PREVIEW_ROOMS,
    config: buildPreviewConfig(),
    guilds: PREVIEW_GUILDS,
    messages: {
      [PREVIEW_ROOM_ALPHA]: alpha,
      [PREVIEW_ROOM_RUNNERS]: runners,
    },
    contracts,
    activeRoomId: PREVIEW_ROOM_ALPHA,
    paneRoomIds: [PREVIEW_ROOM_ALPHA],
  };
}

// ---------------------------------------------------------------------------
// Live stream — one event per tick, cycling a pool so the feed keeps flowing.
// ---------------------------------------------------------------------------

interface StreamSpec {
  roomId: string;
  channelId: string;
  channelName: string;
  caller: PreviewCaller;
  content: string;
  /** When set, the event carries a fresh CA + enriched contract row. */
  token?: PreviewToken;
  mcapUsd?: number;
  reactions?: FrontendMessage['reactions'];
}

const STREAM_SPECS: StreamSpec[] = [
  { roomId: PREVIEW_ROOM_ALPHA, channelId: CH_SOL_ALPHA, channelName: 'alpha-calls', caller: CALLERS.cooker, content: `fresh call — $${TOKENS[2].symbol}, holders climbing fast`, token: TOKENS[2], mcapUsd: 51_000, reactions: [{ emoji: { id: null, name: '🔥' }, count: 4 }] },
  { roomId: PREVIEW_ROOM_ALPHA, channelId: CH_SOL_ALPHA, channelName: 'alpha-calls', caller: CALLERS.mia, content: 'chart on that last one is going vertical lol' },
  { roomId: PREVIEW_ROOM_RUNNERS, channelId: CH_PUMP_RUNNERS, channelName: 'runners', caller: CALLERS.scope, content: `$${TOKENS[5].symbol} on BNB just got a big buy, watching`, token: TOKENS[5], mcapUsd: 1_250_000 },
  { roomId: PREVIEW_ROOM_ALPHA, channelId: CH_SOL_WHALES, channelName: 'whale-watch', caller: CALLERS.jito, content: 'same whale from earlier just added again, conviction buy' },
  { roomId: PREVIEW_ROOM_ALPHA, channelId: CH_SOL_ALPHA, channelName: 'alpha-calls', caller: CALLERS.frank, content: `$${TOKENS[1].symbol} up 3x from my call, taking some profit here`, reactions: [{ emoji: { id: null, name: '💰' }, count: 8 }] },
  { roomId: PREVIEW_ROOM_ALPHA, channelId: CH_SOL_ALPHA, channelName: 'alpha-calls', caller: CALLERS.ansem, content: `new one — $${TOKENS[0].symbol} reclaiming, still early imo`, token: TOKENS[0], mcapUsd: 3_100_000 },
  { roomId: PREVIEW_ROOM_RUNNERS, channelId: CH_PUMP_RUNNERS, channelName: 'runners', caller: CALLERS.scope, content: 'runners channel eating today, stay locked in' },
];

let _seq = 0;

/**
 * Build the next live stream event. Pure given (seq, now): the same seq always
 * maps to the same pool entry, so tests can assert without a clock.
 */
export function buildPreviewStreamEvent(
  seq: number,
  now: number = Date.now(),
): { message: FrontendMessage; roomIds: string[]; contract?: ContractEntry } {
  const spec = STREAM_SPECS[seq % STREAM_SPECS.length];
  const id = `pv-stream-${seq}`;
  const ts = new Date(now).toISOString();

  if (spec.token && spec.mcapUsd != null) {
    const { message, contract, roomIds } = makeCall({
      id,
      roomId: spec.roomId,
      channelId: spec.channelId,
      channelName: spec.channelName,
      caller: spec.caller,
      token: spec.token,
      mcapUsd: spec.mcapUsd,
      content: `${spec.content}\n${spec.token.address}`,
      timestamp: ts,
      reactions: spec.reactions,
    });
    return { message, roomIds, contract };
  }

  const guildId = spec.roomId === PREVIEW_ROOM_RUNNERS ? PREVIEW_GUILD_PUMP : PREVIEW_GUILD_SOL;
  const guildName = spec.roomId === PREVIEW_ROOM_RUNNERS ? 'Pump Runners' : 'Solana Alpha';
  const message = makeMessage(id, spec.channelId, guildId, spec.channelName, guildName, spec.caller, spec.content, ts, {
    isHighlighted: spec.caller.tier === 'trusted',
    reactions: spec.reactions,
  });
  return { message, roomIds: [spec.roomId] };
}

/** Non-pure convenience for the streaming controller: advances the seq. */
export function nextPreviewStreamEvent(now: number = Date.now()) {
  return buildPreviewStreamEvent(_seq++, now);
}

/** Reset the streaming cursor (called when preview is (re)entered). */
export function resetPreviewStream(): void {
  _seq = 0;
}
