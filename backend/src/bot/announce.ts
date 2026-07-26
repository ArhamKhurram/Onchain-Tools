// Update announcements — posted automatically, not via a slash command.
//
// The intended caller is an LLM coding agent (Claude) shipping a change: it
// writes the title/description itself and calls this right after merging, so
// nothing requires a human to type into Discord. Delivery goes through the
// same in-process bot client Phase 2 already connects — no second Discord
// login, no new service.

import type { Client } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { SITE_ACCENT, makeContainer, makeImage, makeSeparator, makeText } from './layout.js';

const KIND_META = {
  site: { icon: '🌐', label: 'Site update' },
  bot: { icon: '🤖', label: 'Bot update' },
} as const;

export type AnnounceKind = keyof typeof KIND_META;

export interface AnnouncePayload {
  title: string;
  description: string;
  kind?: AnnounceKind;
  imageUrl?: string | null;
  linkUrl?: string | null;
}

/** Pure render — matches the site's red/black brand via Components V2. */
export function buildAnnouncementComponents(payload: AnnouncePayload) {
  const { title, description, imageUrl, linkUrl } = payload;
  const meta = KIND_META[payload.kind ?? 'site'];

  return [
    makeContainer(SITE_ACCENT, [
      makeText(`# ${meta.icon} ${title}`),
      makeText(`-# ${meta.label}`),
      makeSeparator(1),
      makeText(description),
      ...(imageUrl ? [makeSeparator(1), makeImage(imageUrl)] : []),
      ...(linkUrl ? [makeText(`[Open →](${linkUrl})`)] : []),
      makeText('-# OCT · Onchain Tools'),
    ]),
  ];
}

export type AnnounceErrorCode =
  | 'bot_disabled'
  | 'not_configured'
  | 'channel_unavailable'
  | 'forbidden'
  | 'send_failed';

export class AnnounceError extends Error {
  constructor(
    public code: AnnounceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnnounceError';
  }
}

function isPermissionError(err: any): boolean {
  return err?.code === 50001 || err?.code === 50013; // Missing Access / Missing Permissions
}

/**
 * Post an announcement to the configured channel via the already-connected bot
 * client. Throws a typed AnnounceError for every failure mode — callers (the
 * HTTP route) map that to a status code without needing to know Discord's
 * error codes.
 */
export async function postAnnouncement(
  client: Client | null,
  payload: AnnouncePayload,
): Promise<{ channelId: string }> {
  if (!client) {
    throw new AnnounceError('bot_disabled', 'The Discord bot is not connected on this instance.');
  }

  const channelId = process.env.DISCORD_ANNOUNCE_CHANNEL_ID?.trim();
  if (!channelId) {
    throw new AnnounceError('not_configured', 'DISCORD_ANNOUNCE_CHANNEL_ID is not configured.');
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err: any) {
    if (isPermissionError(err)) {
      throw new AnnounceError(
        'forbidden',
        "The bot can't see the announcement channel — grant it View Channel there.",
      );
    }
    throw new AnnounceError('channel_unavailable', 'Could not fetch the announcement channel.');
  }

  if (!channel || !('send' in channel)) {
    throw new AnnounceError('channel_unavailable', 'Configured announcement channel is missing or not postable.');
  }

  try {
    await (channel as any).send({
      flags: MessageFlags.IsComponentsV2,
      components: buildAnnouncementComponents(payload),
    });
  } catch (err: any) {
    if (isPermissionError(err)) {
      throw new AnnounceError(
        'forbidden',
        "The bot can't send messages in the announcement channel — grant it Send Messages + Embed Links there.",
      );
    }
    throw new AnnounceError('send_failed', 'Failed to send the announcement.');
  }

  return { channelId };
}
