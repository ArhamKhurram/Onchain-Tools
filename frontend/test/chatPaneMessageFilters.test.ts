import { describe, it, expect } from 'vitest';
import { filterRoomMessages, collectChannelHiddenUsers } from '../src/components/chat-pane/messageFilters';
import { GLOBAL_HIDDEN_USERS_KEY } from '@oct/shared';
import type { FrontendMessage, Room } from '../src/types';

// The pane's visible-message pipeline was inline in ChatPane before the split;
// these pin its three stages (room user-filter → hidden users → focus lens) so
// the extraction stays a pure move.

let seq = 0;
function msg(overrides: Partial<FrontendMessage> = {}): FrontendMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    channelId: 'c1',
    guildId: 'g1',
    channelName: 'general',
    guildName: 'Guild',
    author: { id: 'u1', username: 'user', displayName: 'User One', avatar: null },
    content: `hello ${seq}`,
    timestamp: new Date().toISOString(),
    attachments: [],
    embeds: [],
    isHighlighted: false,
    hasContractAddress: false,
    contractAddresses: [],
    mentions: {},
    ...overrides,
  };
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'r1',
    name: 'Alpha',
    channels: [
      { guildId: 'g1', channelId: 'c1', channelName: 'general', guildName: 'Guild' },
      { guildId: 'g1', channelId: 'c2', channelName: 'calls', guildName: 'Guild' },
    ],
    highlightedUsers: [],
    ...overrides,
  } as Room;
}

const alice = { id: 'u1', username: 'alice', displayName: 'Alice', avatar: null };
const bob = { id: 'u2', username: 'bob', displayName: 'Bob', avatar: null };

describe('filterRoomMessages', () => {
  it('returns every message when no stage applies', () => {
    const list = [msg(), msg()];
    expect(filterRoomMessages(list, room(), {}, null)).toEqual(list);
  });

  it('applies the room user filter by id, username or display name (case-insensitive)', () => {
    const list = [msg({ author: alice }), msg({ author: bob }), msg({ author: { ...bob, id: 'u3' } })];
    const r = room({ filterEnabled: true, filteredUsers: ['u1', 'BOB'] });
    expect(filterRoomMessages(list, r, {}, null).map((m) => m.author.id)).toEqual(['u1', 'u2', 'u3']);
    // Disabled filter with the same list → untouched.
    expect(filterRoomMessages(list, room({ filterEnabled: false, filteredUsers: ['u1'] }), {}, null)).toHaveLength(3);
    // Enabled but empty → untouched.
    expect(filterRoomMessages(list, room({ filterEnabled: true, filteredUsers: [] }), {}, null)).toHaveLength(3);
  });

  it('drops users hidden in that guild:channel only', () => {
    const list = [msg({ author: alice, channelId: 'c1' }), msg({ author: alice, channelId: 'c2' })];
    const hidden = { 'g1:c1': [{ userId: 'u1', displayName: 'Alice' }] };
    expect(filterRoomMessages(list, room(), hidden, null).map((m) => m.channelId)).toEqual(['c2']);
  });

  it('drops users hidden everywhere from every channel', () => {
    const list = [
      msg({ author: alice, channelId: 'c1' }),
      msg({ author: alice, channelId: 'c2' }),
      msg({ author: alice, guildId: null, channelId: 'tg1' }),
      msg({ author: bob, channelId: 'c1' }),
    ];
    const hidden = { [GLOBAL_HIDDEN_USERS_KEY]: [{ userId: 'u1', displayName: 'Alice' }] };
    expect(filterRoomMessages(list, room(), hidden, null).map((m) => m.author.id)).toEqual(['u2']);
  });

  it('keys hidden users on "null" for guild-less (DM/Telegram) messages', () => {
    const list = [msg({ author: alice, guildId: null, channelId: 'tg1' })];
    const hidden = { 'null:tg1': [{ userId: 'u1', displayName: 'Alice' }] };
    expect(filterRoomMessages(list, undefined, hidden, null)).toHaveLength(0);
  });

  it('narrows to the focused channel last', () => {
    const list = [msg({ channelId: 'c1' }), msg({ channelId: 'c2' })];
    const focus = { guildId: 'g1', channelId: 'c2', guildName: 'Guild', channelName: 'calls' };
    expect(filterRoomMessages(list, room(), {}, focus).map((m) => m.channelId)).toEqual(['c2']);
  });
});

describe('collectChannelHiddenUsers', () => {
  it('flattens hidden entries across the room channels with channel context', () => {
    const hidden = {
      'g1:c1': [{ userId: 'u1', displayName: 'Alice' }],
      'g1:c2': [{ userId: 'u2', displayName: 'Bob' }],
      'g9:c9': [{ userId: 'u3', displayName: 'Elsewhere' }],
    };
    const entries = collectChannelHiddenUsers(room(), hidden);
    expect(entries).toEqual([
      { scope: 'channel', userId: 'u1', displayName: 'Alice', guildId: 'g1', channelId: 'c1', channelName: 'general', guildName: 'Guild' },
      { scope: 'channel', userId: 'u2', displayName: 'Bob', guildId: 'g1', channelId: 'c2', channelName: 'calls', guildName: 'Guild' },
    ]);
  });

  it('lists everywhere-hidden users first, tagged global', () => {
    const hidden = {
      [GLOBAL_HIDDEN_USERS_KEY]: [{ userId: 'u9', displayName: 'Spammer' }],
      'g1:c1': [{ userId: 'u1', displayName: 'Alice' }],
    };
    const entries = collectChannelHiddenUsers(room(), hidden);
    expect(entries.map((e) => [e.scope, e.userId])).toEqual([
      ['global', 'u9'],
      ['channel', 'u1'],
    ]);
  });

  it('is empty without a room', () => {
    expect(collectChannelHiddenUsers(undefined, { 'g1:c1': [{ userId: 'u1', displayName: 'A' }] })).toEqual([]);
  });
});
