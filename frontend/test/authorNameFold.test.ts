import { describe, it, expect } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { shallow } from 'zustand/shallow';
import { createMessagesSlice, type MessagesSlice } from '../src/stores/slices/messagesSlice';
import { selectAuthorEntries, authorEntriesToMap } from '../src/utils/authorNameFold';
import type { FrontendMessage } from '../src/types';

// The settings page and the room-config modal need an (author id -> display
// name) lookup built from the message buffers. They used to subscribe to the
// whole s.messages map for it, re-rendering (and re-folding every stored
// message) on every incoming message in any room while they were open. The
// fold's output only changes when the author SET changes, so the subscription
// now goes through useShallow over flat entry strings. These tests pin both
// the quietness and the liveness of that selector, plus content parity with
// the old inline computation.

type TestState = MessagesSlice & {
  unreadCounts: Record<string, number>;
  activeView: string;
  paneRoomIds: string[];
};

function makeStore(): StoreApi<TestState> {
  return createStore<TestState>()((set, get, api) => ({
    ...createMessagesSlice(set as never, get as never, api as never),
    unreadCounts: {},
    activeView: 'chat',
    paneRoomIds: ['room-a'],
  }));
}

let seq = 0;
function msg(authorId: string, displayName: string): FrontendMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    channelId: 'c1',
    guildId: 'g1',
    channelName: 'general',
    guildName: 'Guild',
    author: { id: authorId, username: authorId, displayName, avatar: null },
    content: `hello ${seq}`,
    timestamp: new Date().toISOString(),
    attachments: [],
    embeds: [],
    isHighlighted: false,
    hasContractAddress: false,
    contractAddresses: [],
    mentions: {},
  };
}

function renderCounter<T>(
  store: StoreApi<TestState>,
  selector: (s: TestState) => T,
  equals: (a: T, b: T) => boolean = Object.is,
) {
  let prev = selector(store.getState());
  let renders = 0;
  store.subscribe((state) => {
    const next = selector(state);
    if (!equals(prev, next)) {
      renders += 1;
      prev = next;
    }
  });
  return () => renders;
}

/** The computation the settings surfaces performed inline before the fold. */
function legacyUserNameMap(
  messages: Record<string, FrontendMessage[]>,
  userNameCache: Record<string, string> | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (userNameCache) {
    for (const [id, name] of Object.entries(userNameCache)) map.set(id, name);
  }
  for (const msgs of Object.values(messages)) {
    for (const m of msgs) map.set(m.author.id, m.author.displayName);
  }
  return map;
}

describe('author-name fold selector', () => {
  it('stays quiet under traffic from known authors (whole-map selector did not)', () => {
    const store = makeStore();
    store.getState().addMessage(msg('u1', 'Alice'), ['room-a'], false);

    const foldRenders = renderCounter(store, (s) => selectAuthorEntries(s.messages), shallow);
    const wholeMapRenders = renderCounter(store, (s) => s.messages);

    for (let i = 0; i < 300; i++) {
      store.getState().addMessage(msg('u1', 'Alice'), [i % 2 ? 'room-a' : 'room-b'], false);
    }

    // The old subscription: 300 settings-surface re-renders, each re-scanning
    // every stored message. The folded subscription: zero.
    expect(wholeMapRenders()).toBe(300);
    expect(foldRenders()).toBe(0);
  });

  it('fires when a new author appears or a display name changes', () => {
    const store = makeStore();
    store.getState().addMessage(msg('u1', 'Alice'), ['room-a'], false);
    const foldRenders = renderCounter(store, (s) => selectAuthorEntries(s.messages), shallow);

    store.getState().addMessage(msg('u2', 'Bob'), ['room-a'], false);
    expect(foldRenders()).toBe(1);

    store.getState().addMessage(msg('u2', 'Bobby'), ['room-a'], false);
    expect(foldRenders()).toBe(2);
  });

  it('matches the legacy inline computation, cache overlay included', () => {
    const store = makeStore();
    store.getState().addMessage(msg('u1', 'Alice'), ['room-a'], false);
    store.getState().addMessage(msg('u2', 'Bob'), ['room-b'], false);
    store.getState().addMessage(msg('u1', 'Alice Renamed'), ['room-b'], false);

    const cache = { u3: 'Cached Carol', u1: 'Stale Alice' };
    const { messages } = store.getState();
    const folded = authorEntriesToMap(selectAuthorEntries(messages), cache);
    const legacy = legacyUserNameMap(messages, cache);

    expect(folded).toEqual(legacy);
    // Message-derived names override the cache, same as before.
    expect(folded.get('u1')).toBe('Alice Renamed');
    expect(folded.get('u3')).toBe('Cached Carol');
  });

  it('caches the fold per messages-map identity', () => {
    const store = makeStore();
    store.getState().addMessage(msg('u1', 'Alice'), ['room-a'], false);
    const { messages } = store.getState();
    expect(selectAuthorEntries(messages)).toBe(selectAuthorEntries(messages));
  });
});
