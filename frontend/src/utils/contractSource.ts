import type { AppConfig, ContractEntry } from '../types';

export function isTelegramContract(entry: ContractEntry): boolean {
  return entry.source === 'telegram' || entry.messageId.startsWith('tg_');
}

export function parseTelegramMessageId(messageId: string): { chatId: string; msgId: string } | null {
  if (!messageId.startsWith('tg_')) return null;
  const rest = messageId.slice(3);
  const idx = rest.lastIndexOf('_');
  if (idx <= 0) return null;
  return { chatId: rest.slice(0, idx), msgId: rest.slice(idx + 1) };
}

/** Author + channel line under a contract feed row. */
export function contractAttribution(entry: ContractEntry): string {
  if (isTelegramContract(entry)) {
    return `${entry.authorName} · TG · ${entry.channelName}`;
  }
  return `${entry.authorName} · ${entry.guildName ? `${entry.guildName} / ` : ''}#${entry.channelName}`;
}

export function openContractSource(entry: ContractEntry, config: AppConfig | null): void {
  if (isTelegramContract(entry)) {
    const parsed = parseTelegramMessageId(entry.messageId);
    if (!parsed) return;
    const { chatId, msgId } = parsed;
    let url: string | undefined;
    if (chatId.startsWith('-100')) {
      url = `https://t.me/c/${chatId.slice(4)}/${msgId}`;
    }
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const path = `discord.com/channels/${entry.guildId ?? '@me'}/${entry.channelId}/${entry.messageId}`;
  const useApp = config?.openInDiscordApp ?? false;
  window.open(useApp ? `discord://${path}` : `https://${path}`, useApp ? '_self' : '_blank');
}
