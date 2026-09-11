import { detectContractAddresses } from './contract.js';
import { matchKeywords } from './keyword.js';
import { forwardedParts } from './forward.js';
import type { FrontendMessage, DiscordMessage, DiscordEmbed, KeywordPattern, AppConfig } from './types.js';

/**
 * Flatten every text-bearing field of an embed into one blob.
 *
 * Bots almost always post a contract in an embed with an empty `content`, so
 * scanning `content` alone made their calls undetectable — and therefore
 * unclickable. Rick was the exception only because it has a dedicated parser
 * (`rickEmbedParser`), which meant CAs silently stopped working whenever Rick
 * was down or a different scanner posted instead.
 */
export function embedTextBlob(embeds: DiscordEmbed[] | undefined): string {
  if (!embeds?.length) return '';
  const parts: string[] = [];
  for (const e of embeds) {
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    if (e.url) parts.push(e.url);
    if (e.author?.name) parts.push(e.author.name);
    if (e.author?.url) parts.push(e.author.url);
    if (e.footer?.text) parts.push(e.footer.text);
    for (const f of e.fields ?? []) {
      parts.push(f.name, f.value);
    }
  }
  return parts.join('\n');
}

// Shared Discord message → FrontendMessage transform, used by the backend
// ingestion pipeline and the browser gateway. Previously duplicated (identical
// body) in backend/src/utils/messageProcessor.ts and
// frontend/src/discord/processMessage.ts. Config is injected via ctx; each side's
// wrapper supplies it (backend from configStore, frontend requires it).

export interface MessageProcessorContext {
  config: AppConfig;
  isHighlighted: boolean;
  cacheUserName: (discordUserId: string, displayName: string) => void;
}

// The minimal slice of a Discord gateway this transform needs. Both the backend
// GatewayManager and the browser GatewayManager satisfy it structurally.
export interface MessageGateway {
  getChannelName(channelId: string): string;
  getGuildName(guildId: string): string | null;
  getRoleName(roleId: string): string | null;
  getMemberRoleColor(roleIds: string[] | undefined): string | null;
}

/**
 * Best-effort "where this was forwarded from" label.
 *
 * A snapshot carries no origin of its own, so the only clue is the forward's
 * `message_reference`. People forward across servers constantly, so the source
 * is often a guild this client isn't in: rather than print the gateway's
 * "unknown" placeholder, return null and let the UI show a bare "Forwarded".
 */
function forwardOrigin(
  gateway: MessageGateway,
  ref: DiscordMessage['message_reference'],
): string | null {
  if (!ref?.channel_id) return null;
  const channel = gateway.getChannelName(ref.channel_id);
  if (!channel || channel === 'unknown') return null;
  const guild = ref.guild_id ? gateway.getGuildName(ref.guild_id) : null;
  return guild ? `${guild} / #${channel}` : `#${channel}`;
}

export function processDiscordMessage(
  gateway: MessageGateway,
  rawMsg: DiscordMessage,
  channelName: string | undefined,
  guildName: string | null | undefined,
  roomKeywordPatterns: KeywordPattern[] | undefined,
  ctx: MessageProcessorContext,
): FrontendMessage {
  const { config, isHighlighted, cacheUserName } = ctx;

  // A forward keeps its body in `message_snapshots`, never in `content` — see
  // forward.ts. Scan the forwarded body alongside the message's own: a
  // forwarded call is still a call, and reading `content` alone made every
  // forward both blank and undetectable.
  const forwarded = forwardedParts(rawMsg);
  const ownText = rawMsg.content ?? '';
  const scannableText = forwarded?.content ? `${ownText}\n${forwarded.content}` : ownText;

  let contractResult = { hasContract: false, addresses: [] as string[] };
  if (config.contractDetection) {
    // Scan embeds as well as content: bot calls carry the CA in an embed with
    // an empty content string, so content-only detection missed every bot that
    // was not Rick.
    const embedBlob = embedTextBlob([...(rawMsg.embeds ?? []), ...(forwarded?.embeds ?? [])]);
    const scanned = embedBlob ? `${scannableText}\n${embedBlob}` : scannableText;
    contractResult = detectContractAddresses(scanned);
  }

  let matchedKeywords: string[] = [];
  if (config.keywordAlertsEnabled) {
    const allPatterns = [...(config.globalKeywordPatterns ?? []), ...(roomKeywordPatterns ?? [])];
    matchedKeywords = matchKeywords(scannableText, allPatterns);
  }

  const mentionsMap: Record<string, string> = {};
  // The forwarded body's mentions go in the same map: it renders through the
  // same `<@id>` resolver, and without them a forwarded "gm @someone" shows a
  // raw id.
  for (const user of [...(rawMsg.mentions ?? []), ...(forwarded?.mentions ?? [])]) {
    mentionsMap[user.id] = user.global_name ?? user.username;
  }
  for (const ch of rawMsg.mention_channels ?? []) {
    mentionsMap[`ch:${ch.id}`] = ch.name;
  }
  const channelMentionRegex = /<#(\d+)>/g;
  let chMatch;
  while ((chMatch = channelMentionRegex.exec(scannableText)) !== null) {
    if (!mentionsMap[`ch:${chMatch[1]}`]) {
      const chName = gateway.getChannelName(chMatch[1]);
      if (chName !== 'unknown') mentionsMap[`ch:${chMatch[1]}`] = chName;
    }
  }
  const roleMentionRegex = /<@&(\d+)>/g;
  let roleMatch;
  while ((roleMatch = roleMentionRegex.exec(scannableText)) !== null) {
    const rName = gateway.getRoleName(roleMatch[1]);
    if (rName) mentionsMap[`role:${roleMatch[1]}`] = rName;
  }

  const resolvedChannelName = channelName ?? gateway.getChannelName(rawMsg.channel_id);
  const guildId = rawMsg.guild_id ?? null;
  const resolvedGuildName = guildName !== undefined ? guildName : (guildId ? gateway.getGuildName(guildId) : null);

  const displayName = rawMsg.author.global_name ?? rawMsg.author.username;
  cacheUserName(rawMsg.author.id, displayName);

  return {
    id: rawMsg.id,
    channelId: rawMsg.channel_id,
    guildId,
    channelName: resolvedChannelName,
    guildName: resolvedGuildName,
    author: {
      id: rawMsg.author.id,
      username: rawMsg.author.username,
      displayName: rawMsg.author.global_name ?? rawMsg.author.username,
      avatar: rawMsg.author.avatar,
      roleColor: gateway.getMemberRoleColor(rawMsg.member?.roles) ?? null,
    },
    content: rawMsg.content,
    timestamp: rawMsg.timestamp,
    attachments: rawMsg.attachments ?? [],
    embeds: rawMsg.embeds ?? [],
    isHighlighted,
    hasContractAddress: contractResult.hasContract,
    contractAddresses: contractResult.addresses,
    mentions: mentionsMap,
    referencedMessage: rawMsg.referenced_message
      ? (() => {
          const refMentions: Record<string, string> = {};
          for (const user of rawMsg.referenced_message!.mentions ?? []) {
            refMentions[user.id] = user.global_name ?? user.username;
          }
          return {
            id: rawMsg.referenced_message!.id,
            author: rawMsg.referenced_message!.author.global_name ?? rawMsg.referenced_message!.author.username,
            content: rawMsg.referenced_message!.content,
            mentions: refMentions,
          };
        })()
      : null,
    forwardedMessage: forwarded
      ? {
          content: forwarded.content,
          attachments: forwarded.attachments,
          embeds: forwarded.embeds,
          timestamp: forwarded.timestamp,
          origin: forwardOrigin(gateway, rawMsg.message_reference),
        }
      : null,
    reactions: (rawMsg.reactions ?? []).map((r) => ({
      emoji: r.emoji,
      count: r.count,
    })),
    matchedKeywords: matchedKeywords.length > 0 ? matchedKeywords : undefined,
    isEdited: !!rawMsg.edited_timestamp,
    editedTimestamp: rawMsg.edited_timestamp ?? null,
  };
}
