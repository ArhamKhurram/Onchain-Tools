import type { DiscordAttachment, DiscordEmbed, DiscordMessage, DiscordUser } from './types.js';

/**
 * Discord forwards, and why they need their own module.
 *
 * A forward is NOT a reply. It arrives as a message whose `message_reference`
 * has `type: 1` (FORWARD) and whose forwarded body lives in a
 * `message_snapshots` array — the outer message's `content`, `embeds` and
 * `attachments` describe only what the forwarder typed alongside it, which for
 * a plain "forward this to the room" is nothing at all.
 *
 * So anything that reads `content`/`embeds` sees an empty message: the feed
 * rendered a blank row, and contract detection never saw the address that was
 * the entire reason someone forwarded the call. These helpers are the one place
 * that knows where a forward keeps its text; both the backend ingest pipeline
 * (local mode) and the browser gateway (hosted mode) go through them via
 * `processDiscordMessage`.
 *
 * Snapshots deliberately carry no author, id or channel_id — Discord tells you
 * what was forwarded, not who wrote it. Never synthesise one.
 */

/** `message_reference.type` values. Absent means DEFAULT: before forwards existed, a reference was always a reply. */
export const MESSAGE_REFERENCE_DEFAULT = 0;
export const MESSAGE_REFERENCE_FORWARD = 1;

/** A forward's payload, collapsed from `message_snapshots` into one body. */
export interface ForwardedParts {
  content: string;
  embeds: DiscordEmbed[];
  attachments: DiscordAttachment[];
  /** Origin post time, from the first snapshot that has one. */
  timestamp: string | null;
  /** Users mentioned inside the forwarded body, so `<@id>` still resolves to a name. */
  mentions: DiscordUser[];
}

/**
 * True when this message's reference is a forward rather than a reply.
 *
 * Checked against the reference type, not the snapshot array, because it also
 * answers the inverse question: a caller holding a `message_reference` must not
 * treat a forward as a reply (the referenced id points into another channel).
 */
export function isForwardReference(
  ref: { type?: number } | null | undefined,
): boolean {
  return ref?.type === MESSAGE_REFERENCE_FORWARD;
}

/**
 * Collapse `message_snapshots` into a single forwarded body, or null when the
 * message isn't a forward.
 *
 * The array is plural and joined in order because the shape allows more than
 * one snapshot; Discord sends a single entry today, so in practice this is a
 * one-element join. Presence of snapshots — not the reference type — is the
 * gate: the body is only readable if it was actually sent.
 */
export function forwardedParts(msg: {
  message_snapshots?: DiscordMessage['message_snapshots'];
}): ForwardedParts | null {
  const snapshots = msg.message_snapshots;
  if (!snapshots?.length) return null;

  const contents: string[] = [];
  const embeds: DiscordEmbed[] = [];
  const attachments: DiscordAttachment[] = [];
  const mentions: DiscordUser[] = [];
  let timestamp: string | null = null;

  for (const snap of snapshots) {
    const m = snap?.message;
    if (!m) continue;
    if (m.content) contents.push(m.content);
    if (m.embeds?.length) embeds.push(...m.embeds);
    if (m.attachments?.length) attachments.push(...m.attachments);
    if (m.mentions?.length) mentions.push(...m.mentions);
    if (!timestamp && m.timestamp) timestamp = m.timestamp;
  }

  return { content: contents.join('\n'), embeds, attachments, timestamp, mentions };
}

/**
 * The text a scanner should read for this message: its own content with the
 * forwarded body appended.
 *
 * Callers that scan raw text (EVM chain hints, GMGN links, the reply-preview
 * cache) use this so a forwarded call is treated like any other call. Returns
 * `msg.content` unchanged when there is no forward, so it is safe to apply
 * everywhere rather than behind an `isForward` branch.
 */
export function contentWithForward(msg: {
  content?: string;
  message_snapshots?: DiscordMessage['message_snapshots'];
}): string {
  const parts = forwardedParts(msg);
  const own = msg.content ?? '';
  if (!parts?.content) return own;
  return own ? `${own}\n${parts.content}` : parts.content;
}

/** Embeds to scan for this message: its own plus any carried by a forward. */
export function embedsWithForward(msg: {
  embeds?: DiscordEmbed[];
  message_snapshots?: DiscordMessage['message_snapshots'];
}): DiscordEmbed[] {
  const parts = forwardedParts(msg);
  if (!parts?.embeds.length) return msg.embeds ?? [];
  return [...(msg.embeds ?? []), ...parts.embeds];
}
