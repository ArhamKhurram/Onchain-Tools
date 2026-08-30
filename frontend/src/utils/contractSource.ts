import type { AppConfig, ContractEntry } from '../types';

export function isTelegramContract(entry: ContractEntry): boolean {
  return entry.source === 'telegram' || entry.messageId.startsWith('tg_');
}

function parseTelegramMessageId(messageId: string): { chatId: string; msgId: string } | null {
  if (!messageId.startsWith('tg_')) return null;
  const rest = messageId.slice(3);
  const idx = rest.lastIndexOf('_');
  if (idx <= 0) return null;
  return { chatId: rest.slice(0, idx), msgId: rest.slice(idx + 1) };
}

/** Author + channel line under a contract feed row. */
export function contractAttribution(entry: ContractEntry): string {
  if (isTelegramContract(entry)) {
    // A forum-topic detection carries the group as guildName and the topic as
    // channelName — show both, mirroring the Discord "guild / #channel" shape.
    return `${entry.authorName} · TG · ${entry.guildName ? `${entry.guildName} / ` : ''}${entry.channelName}`;
  }
  return `${entry.authorName} · ${entry.guildName ? `${entry.guildName} / ` : ''}#${entry.channelName}`;
}

/**
 * The `t.me` deep link for a Telegram row, or null when one can't be built.
 *
 * Only supergroups/channels (chat ids prefixed `-100`) have a public message
 * URL shape; plain groups and DMs don't, so those rows are unlinkable rather
 * than broken.
 */
function telegramMessageUrl(entry: ContractEntry): string | null {
  const parsed = parseTelegramMessageId(entry.messageId);
  if (!parsed) return null;
  const { chatId, msgId } = parsed;
  if (!chatId.startsWith('-100')) return null;
  return `https://t.me/c/${chatId.slice(4)}/${msgId}`;
}

/**
 * Would `openContractSource` actually open something for this row?
 *
 * Discord rows always produce a URL. Telegram rows only do when the chat id is
 * a supergroup/channel — for anything else `openContractSource` silently
 * returns, so callers that want to *offer* the action (rather than just try it)
 * need to know in advance.
 */
export function canOpenContractSource(entry: ContractEntry): boolean {
  if (isTelegramContract(entry)) return telegramMessageUrl(entry) !== null;
  return true;
}

export function openContractSource(entry: ContractEntry, config: AppConfig | null): void {
  if (isTelegramContract(entry)) {
    const url = telegramMessageUrl(entry);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const path = `discord.com/channels/${entry.guildId ?? '@me'}/${entry.channelId}/${entry.messageId}`;
  const useApp = config?.openInDiscordApp ?? false;
  window.open(useApp ? `discord://${path}` : `https://${path}`, useApp ? '_self' : '_blank');
}
