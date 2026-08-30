import { describe, it, expect } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { shallow } from 'zustand/shallow';
import { createMessagesSlice, type MessagesSlice } from '../src/stores/slices/messagesSlice';
import { selectDmSwitcherEntries, parseDmSwitcherEntry } from '../src/utils/dmSwitcherEntries';
import type { FrontendMessage } from '../src/types';

// ChatPane used to subscribe to the WHOLE `s.messages` map, so every incoming
// message — in any room — re-rendered every mounted pane (4x with a full split
// layout, ~985 lines of component each). `addMessage` only swaps the touched
// room's array reference, so a per-room subscription is naturally quiet under
// cross-room traffic. Zustand re-renders exactly when the selector's output
// fails its equality check, so counting output changes across store writes IS
// the re-render count; these tests pin that contract for the narrowed
// selectors ChatPane now uses.

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

/** Mimic a React subscription: count how often the selector's output changes. */
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

describe('ChatPane per-room message selector', () => {
  it('stays quiet under cross-room traffic (the whole-map selector did not)', () => {
    const store = makeStore();
    store.getState().addMessage(msg(), ['room-a'], false);

    const paneRenders = renderCounter(store, (s) => s.messages['room-a']);
    const wholeMapRenders = renderCounter(store, (s) => s.messages);

    for (let i = 0; i < 500; i++) {
      store.getState().addMessage(msg(), ['room-b'], true);
    }

    // The old subscription: 500 re-renders per pane for messages it never shows.
    expect(wholeMapRenders()).toBe(500);
    // The narrowed subscription: zero.
    expect(paneRenders()).toBe(0);
  });

  it('still re-renders when its own room receives a message', () => {
    const store = makeStore();
    store.getState().addMessage(msg(), ['room-a'], false);
    const paneRenders = renderCounter(store, (s) => s.messages['room-a']);

    store.getState().addMessage(msg(), ['room-a'], false);
    expect(paneRenders()).toBe(1);

    // Duplicate ids are dropped without a state change.
    const dupe = msg();
    store.getState().addMessage(dupe, ['room-a'], false);
    store.getState().addMessage(dupe, ['room-a'], false);
    expect(paneRenders()).toBe(2);
  });
});

describe('DM switcher entries selector', () => {
  it('is shallow-stable under message traffic, and fires when a DM room appears', () => {
    const store = makeStore();
    store.getState().addMessage(msg({ channelId: 'd1' }), ['dm:d1'], false);
    store.getState().addMessage(msg({ channelName: 'TG Chat' }), ['tg-dm:t1'], false);

    const switcherRenders = renderCounter(
      store,
      (s) => selectDmSwitcherEntries(s.messages),
      shallow,
    );

    // Traffic into normal rooms AND into the existing DM rooms: the folded
    // label strings don't change, so the switcher subscription stays quiet.
    for (let i = 0; i < 200; i++) {
      store.getState().addMessage(msg(), ['room-b'], true);
      store.getState().addMessage(msg({ channelId: 'd1' }), ['dm:d1'], false);
    }
    expect(switcherRenders()).toBe(0);

    // A brand-new DM room is exactly what the dropdown must pick up.
    store.getState().addMessage(msg({ channelId: 'd2' }), ['dm:d2'], false);
    expect(switcherRenders()).toBe(1);
  });

  it('round-trips keys and labels containing spaces and colons', () => {
    const store = makeStore();
    store
      .getState()
      .addMessage(
        msg({
          channelName: 'Group: friends & co',
          author: { id: 'u9', username: 'x', displayName: 'Display Name With Spaces', avatar: null },
        }),
        ['tg-dm:t9'],
        false,
      );

    const entries = selectDmSwitcherEntries(store.getState().messages);
    expect(entries).toHaveLength(1);
    const parsed = parseDmSwitcherEntry(entries[0]);
    expect(parsed.key).toBe('tg-dm:t9');
    expect(parsed.channelName).toBe('Group: friends & co');
    expect(parsed.authorName).toBe('Display Name With Spaces');
  });

  it('lists only DM rooms that hold messages', () => {
    const store = makeStore();
    store.getState().addMessage(msg(), ['room-a'], false);
    store.getState().addMessage(msg({ channelId: 'd1' }), ['dm:d1'], false);
    const entries = selectDmSwitcherEntries(store.getState().messages);
    expect(entries.map((e) => parseDmSwitcherEntry(e).key)).toEqual(['dm:d1']);
  });
});
