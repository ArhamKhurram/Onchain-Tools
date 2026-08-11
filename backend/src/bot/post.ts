// One-off channel posts for machine callers (launch trackers, CI scripts) via
// the already-connected bot client. Sibling of announce.ts: same typed-error
// mapping pattern, but the caller picks the channel and supplies plain
// content/embed instead of the branded announcement layout. Rate limiting is
// discord.js's own request queue — callers get backpressure, not 429 storms.

import type { Client } from 'discord.js';

export interface PostPayload {
  channelId: string;
  content?: string | null;
  embed?: Record<string, unknown> | null;
}

export type PostErrorCode =
  | 'bot_disabled'
  | 'invalid'
  | 'channel_unknown'
  | 'forbidden'
  | 'send_failed';

export class PostError extends Error {
  constructor(
    public code: PostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PostError';
  }
}

const MAX_CONTENT_LENGTH = 2000; // Discord's hard message-content cap

function isPermissionError(err: any): boolean {
  return err?.code === 50001 || err?.code === 50013; // Missing Access / Missing Permissions
}

function isUnknownChannelError(err: any): boolean {
  return err?.code === 10003; // Unknown Channel
}

/** Pure validation/normalization — unit-testable without a client. */
export function buildPostMessage(payload: PostPayload): {
  content?: string;
  embeds?: Record<string, unknown>[];
} {
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  const embed = payload.embed;
  if (embed !== undefined && embed !== null && (typeof embed !== 'object' || Array.isArray(embed))) {
    throw new PostError('invalid', 'embed must be an object.');
  }
  if (!content && !embed) {
    throw new PostError('invalid', 'At least one of content or embed is required.');
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new PostError('invalid', `content exceeds ${MAX_CONTENT_LENGTH} characters.`);
  }
  return {
    ...(content ? { content } : {}),
    ...(embed ? { embeds: [embed] } : {}),
  };
}

/**
 * Post one message to a channel via the connected bot client. Throws a typed
 * PostError for every failure mode — the HTTP route maps codes to statuses
 * (unknown channel → 404) without knowing Discord's error codes.
 */
export async function postToChannel(
  client: Client | null,
  payload: PostPayload,
): Promise<{ channelId: string; messageId: string | null }> {
  const message = buildPostMessage(payload); // throws 'invalid' first

  if (!client) {
    throw new PostError('bot_disabled', 'The Discord bot is not connected on this instance.');
  }

  const channelId = payload.channelId?.trim();
  if (!channelId) {
    throw new PostError('invalid', 'channelId is required.');
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err: any) {
    if (isUnknownChannelError(err)) {
      throw new PostError('channel_unknown', `No channel with id ${channelId} is visible to the bot.`);
    }
    if (isPermissionError(err)) {
      throw new PostError('forbidden', "The bot can't see that channel — grant it View Channel there.");
    }
    throw new PostError('channel_unknown', `Could not fetch channel ${channelId}.`);
  }

  if (!channel || !('send' in channel)) {
    throw new PostError('channel_unknown', `Channel ${channelId} is missing or not postable.`);
  }

  try {
    const sent = await (channel as any).send(message);
    return { channelId, messageId: sent?.id ?? null };
  } catch (err: any) {
    if (isPermissionError(err)) {
      throw new PostError(
        'forbidden',
        "The bot can't send messages in that channel — grant it Send Messages + Embed Links there.",
      );
    }
    throw new PostError('send_failed', 'Failed to send the message.');
  }
}
