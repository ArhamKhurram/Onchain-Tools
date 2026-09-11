import { describe, it, expect } from 'vitest';
import {
  MESSAGE_REFERENCE_FORWARD,
  isForwardReference,
  forwardedParts,
  contentWithForward,
  embedsWithForward,
} from '@oct/shared';
import type { DiscordMessage } from '../src/discord/types.js';

// A forward as Discord actually sends it: `content` empty, `embeds`/`attachments`
// empty, everything the user forwarded tucked into `message_snapshots`. This is
// the payload that used to render as a blank row in the feed.
const forward = (over: Partial<DiscordMessage> = {}): DiscordMessage =>
  ({
    id: 'm1',
    channel_id: 'chan-1',
    guild_id: 'g1',
    author: { id: 'u1', username: 'satoshi', global_name: 'Satoshi', avatar: null },
    content: '',
    timestamp: '2026-01-02T00:00:00.000Z',
    attachments: [],
    embeds: [],
    message_reference: {
      type: MESSAGE_REFERENCE_FORWARD,
      message_id: 'src-1',
      channel_id: '999',
      guild_id: 'g2',
    },
    message_snapshots: [
      {
        message: {
          type: 0,
          content: 'ape this',
          embeds: [],
          attachments: [],
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      },
    ],
    ...over,
  } as unknown as DiscordMessage);

describe('isForwardReference', () => {
  it('is true only for type 1', () => {
    expect(isForwardReference({ type: MESSAGE_REFERENCE_FORWARD })).toBe(true);
    expect(isForwardReference({ type: 0 })).toBe(false);
    // Pre-forward payloads omit the field entirely; a reference with no type is a reply.
    expect(isForwardReference({})).toBe(false);
    expect(isForwardReference(null)).toBe(false);
    expect(isForwardReference(undefined)).toBe(false);
  });
});

describe('forwardedParts', () => {
  it('returns null when there is no snapshot', () => {
    expect(forwardedParts({})).toBeNull();
    expect(forwardedParts({ message_snapshots: [] })).toBeNull();
  });

  it('reads content, timestamp, embeds, attachments and mentions out of the snapshot', () => {
    const parts = forwardedParts(
      forward({
        message_snapshots: [
          {
            message: {
              content: 'CA below',
              timestamp: '2026-01-01T00:00:00.000Z',
              embeds: [{ description: 'scanner card' }],
              attachments: [{ id: 'a1', filename: 'chart.png', url: 'u', proxy_url: 'p', size: 1 }],
              mentions: [{ id: 'u9', username: 'vitalik', discriminator: '0', avatar: null }],
            },
          },
        ],
      }),
    );
    expect(parts).not.toBeNull();
    expect(parts!.content).toBe('CA below');
    expect(parts!.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(parts!.embeds).toEqual([{ description: 'scanner card' }]);
    expect(parts!.attachments).toHaveLength(1);
    expect(parts!.mentions.map((m) => m.id)).toEqual(['u9']);
  });

  // The field is an array in the API even though Discord sends one entry today.
  it('joins multiple snapshots in order and takes the first timestamp', () => {
    const parts = forwardedParts({
      message_snapshots: [
        { message: { content: 'first', timestamp: '2026-01-01T00:00:00.000Z', embeds: [{ title: 'a' }] } },
        { message: { content: 'second', timestamp: '2026-01-03T00:00:00.000Z', embeds: [{ title: 'b' }] } },
      ],
    });
    expect(parts!.content).toBe('first\nsecond');
    expect(parts!.embeds).toEqual([{ title: 'a' }, { title: 'b' }]);
    expect(parts!.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('survives a snapshot with nothing in it', () => {
    const parts = forwardedParts({
      message_snapshots: [{ message: {} }, { message: { content: 'kept' } }],
    });
    expect(parts!.content).toBe('kept');
    expect(parts!.embeds).toEqual([]);
    expect(parts!.attachments).toEqual([]);
    expect(parts!.timestamp).toBeNull();
  });
});

describe('contentWithForward', () => {
  it('returns the message content unchanged when nothing was forwarded', () => {
    expect(contentWithForward({ content: 'plain message' })).toBe('plain message');
    expect(contentWithForward({})).toBe('');
  });

  it('returns the forwarded body when the forwarder added no comment', () => {
    expect(contentWithForward(forward())).toBe('ape this');
  });

  it('keeps the forwarder’s own comment ahead of the forwarded body', () => {
    expect(contentWithForward(forward({ content: 'look at this' }))).toBe('look at this\nape this');
  });
});

describe('embedsWithForward', () => {
  it('passes the message’s own embeds through untouched when nothing was forwarded', () => {
    const own = [{ title: 'mine' }];
    expect(embedsWithForward({ embeds: own })).toEqual(own);
    expect(embedsWithForward({})).toEqual([]);
  });

  it('appends forwarded embeds after the message’s own', () => {
    const merged = embedsWithForward(
      forward({
        embeds: [{ title: 'mine' }],
        message_snapshots: [{ message: { embeds: [{ title: 'forwarded' }] } }],
      }),
    );
    expect(merged).toEqual([{ title: 'mine' }, { title: 'forwarded' }]);
  });
});
