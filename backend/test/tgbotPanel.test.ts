// The /start control panel, as pure functions.
//
// Three properties are worth a test suite here, and they are the three that
// would be expensive to get wrong in production:
//
//   1. THE PANEL SUBSCRIBES NOTHING. alertPolicy.ts exists because the first
//      release turned OCT's loudest event class on at /start and flooded a live
//      group. Buttons are a tempting place to reintroduce that by accident — a
//      helpful default, a one-tap "get started" — so the fail-closed property
//      is asserted against the panel's own entry points, not only the policy's.
//
//   2. CALLBACK DATA IS UNTRUSTED. Telegram echoes whatever byte string a
//      button carried, and nothing stops a crafted client sending one that was
//      never rendered. The parser is a whitelist; these tests are the whitelist
//      stated from the outside.
//
//   3. AUTHORIZATION IS PER PRESS. The card is a shared message and the query
//      carries the PRESSER, who in a group is any member. decidePanelPress is
//      the whole rule, so it gets a table.

import { describe, it, expect } from 'vitest';
import {
  ALERT_CATALOG,
  ALERT_TYPES,
  DEFAULT_CHAT_SETTINGS,
  subscribedTypes,
  type TgChatSettings,
} from '../src/tgbot/alertPolicy';
import {
  allPanelActions,
  buildConfirmKeyboard,
  buildPanelKeyboard,
  decidePanelPress,
  encodePanelAction,
  isPanelWrite,
  MAX_CALLBACK_DATA_BYTES,
  needsConfirmation,
  nextDelivery,
  panelHomeSettings,
  parsePanelAction,
  readConsoleUrl,
  renderPanelHome,
  renderPanelRecent,
  renderPanelStatus,
  renderPanelView,
  type PanelAction,
  type PanelActor,
  type PanelState,
} from '../src/tgbot/panel';
import { DigestBuffer } from '../src/tgbot/digest';
import type { TgChatRecord } from '../src/tgbot/chatStore';

const settings = (over: Partial<TgChatSettings['alerts']> = {}): TgChatSettings => ({
  ...DEFAULT_CHAT_SETTINGS,
  alerts: { ...DEFAULT_CHAT_SETTINGS.alerts, ...over },
});

const record = (over: Partial<TgChatRecord> = {}): TgChatRecord => ({
  chatId: -100123,
  chatType: 'supergroup',
  title: 'A group',
  addedByTgUserId: 7,
  enabled: true,
  sourceUserId: null,
  settings: settings(),
  plan: 'free',
  entitlements: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const state = (over: Partial<PanelState> = {}): PanelState => ({
  view: 'home',
  record: record(),
  settings: settings(),
  alertsRouted: true,
  boundAccount: null,
  filters: null,
  digestMinutes: 10,
  maxPerHour: 10,
  usedThisHour: 0,
  pending: [],
  pendingDropped: 0,
  now: Date.parse('2026-09-06T12:34:56.000Z'),
  ...over,
});

const actor = (over: Partial<PanelActor> = {}): PanelActor => ({
  chatId: -100123,
  chatType: 'supergroup',
  userId: 7,
  chatAllowed: true,
  isAdmin: false,
  ...over,
});

/** Every callback token the keyboards can actually render, in any state. */
function everyRenderedToken(): string[] {
  const tokens: string[] = [];
  const collect = (rows: { callback_data?: string }[][]): void => {
    for (const row of rows) for (const b of row) if (b.callback_data) tokens.push(b.callback_data);
  };

  const views = ['home', 'alerts', 'digest', 'recent', 'status', 'help'] as const;
  const deliveries = ['off', 'digest', 'instant'] as const;

  for (const view of views) {
    for (const delivery of deliveries) {
      const all = Object.fromEntries(ALERT_TYPES.map((t) => [t, delivery])) as TgChatSettings['alerts'];
      collect(buildPanelKeyboard(state({ view, settings: { ...settings(), alerts: all } })).inline_keyboard);
    }
  }
  // The muted variant of home, which adds the Unmute row.
  collect(
    buildPanelKeyboard(
      state({ settings: { ...settings(), mutedUntil: Date.parse('2026-09-06T18:00:00.000Z') } }),
    ).inline_keyboard,
  );
  for (const type of ALERT_TYPES) collect(buildConfirmKeyboard(type).inline_keyboard);
  return tokens;
}

// ---------------------------------------------------------------------------

describe('fail closed: opening the panel subscribes nothing', () => {
  // THE test, restated for the button surface. /start hands the panel
  // DEFAULT_CHAT_SETTINGS and writes no settings at all, so this is what a chat
  // that has only opened the panel is subscribed to.
  it('the panel default is the same object the fan-out reads', () => {
    expect(panelHomeSettings()).toBe(DEFAULT_CHAT_SETTINGS);
    // Every INCIDENT class is off; octSignals ("OCT Alerts") is the one
    // deliberate default-on exception — a curated operator stream, on the
    // operator's explicit instruction (see DEFAULT_CHAT_SETTINGS).
    expect(subscribedTypes(panelHomeSettings())).toEqual(['octSignals']);
    for (const type of ['missedRunner', 'mcapCross', 'keyword', 'highlighted', 'contract'] as const) {
      expect(panelHomeSettings().alerts[type]).toBe('off');
    }
  });

  it('the home card of a fresh chat shows OCT Alerts on and no loud class', () => {
    const card = renderPanelHome(state({ settings: panelHomeSettings() }), null);
    expect(card).toContain('OCT Alerts');
    // The class that flooded a live group is still off for a fresh chat.
    expect(card).not.toContain('Contract detections');
  });

  it('no keyboard a fresh chat can see carries a subscribe token', () => {
    // A brand-new chat opens on `home`, and every button there is a view, a
    // refresh, or close. Reaching a subscription takes a deliberate tap into
    // the alerts card first.
    const home = buildPanelKeyboard(state({ settings: panelHomeSettings() }));
    const tokens = home.inline_keyboard.flat().map((b) => b.callback_data);
    for (const token of tokens) {
      expect(parsePanelAction(token)?.kind).not.toBe('set');
    }
  });

  it('the loud class is unreachable in one press, by construction', () => {
    // contract.requiresConfirmation is what caused the incident. The alerts
    // keyboard must offer it as a `confirm` (which only renders a warning),
    // never as a `set`.
    const keyboard = buildPanelKeyboard(state({ view: 'alerts', settings: panelHomeSettings() }));
    const actions = keyboard.inline_keyboard
      .flat()
      .map((b) => parsePanelAction(b.callback_data))
      .filter((a): a is PanelAction => a !== null);

    const contractAction = actions.find(
      (a) => (a.kind === 'set' || a.kind === 'confirm') && a.type === 'contract',
    );
    expect(contractAction).toEqual({ kind: 'confirm', type: 'contract' });
  });

  it('every one-tap subscribe is a digest, never per-event', () => {
    for (const type of ALERT_TYPES) {
      expect(nextDelivery(ALERT_CATALOG[type], 'off')).toBe('digest');
    }
  });

  it('per-event delivery is only offered where the class allows it', () => {
    for (const type of ALERT_TYPES) {
      const spec = ALERT_CATALOG[type];
      const next = nextDelivery(spec, 'digest');
      expect(next).toBe(spec.instantAllowed ? 'instant' : 'off');
    }
  });

  it('the cycle always returns to off', () => {
    for (const type of ALERT_TYPES) {
      const spec = ALERT_CATALOG[type];
      let delivery = nextDelivery(spec, 'off');
      const seen = new Set([delivery]);
      for (let i = 0; i < 4 && delivery !== 'off'; i += 1) {
        delivery = nextDelivery(spec, delivery);
        seen.add(delivery);
      }
      expect(delivery).toBe('off');
    }
  });

  it('confirmation is required only when turning a flagged class ON from off', () => {
    const contract = ALERT_CATALOG.contract;
    expect(needsConfirmation(contract, 'off')).toBe(true);
    // Already subscribed: cycling its delivery is not the destructive act.
    expect(needsConfirmation(contract, 'digest')).toBe(false);
    expect(needsConfirmation(ALERT_CATALOG.missedRunner, 'off')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('callback data: round-trip and the 64-byte bound', () => {
  it('every action the panel can emit survives a round trip', () => {
    for (const action of allPanelActions()) {
      expect(parsePanelAction(encodePanelAction(action))).toEqual(action);
    }
  });

  it('every token a keyboard actually renders is within Telegram’s limit', () => {
    const tokens = everyRenderedToken();
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(Buffer.byteLength(token, 'utf8')).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
    }
  });

  it('every token a keyboard renders parses back to something', () => {
    for (const token of everyRenderedToken()) {
      expect(parsePanelAction(token)).not.toBeNull();
    }
  });
});

describe('callback data is untrusted input', () => {
  const rejected: [string, string | undefined | null][] = [
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['no version', 'v:home'],
    ['wrong version', 'p0:v:home'],
    ['future version', 'p2:v:home'],
    ['unknown verb', 'p1:z:home'],
    ['unknown view', 'p1:v:admin'],
    ['unknown alert type', 'p1:s:everything:digest'],
    ['unknown delivery', 'p1:s:contract:always'],
    ['view with a stray argument', 'p1:v:home:extra'],
    ['unmute with a stray argument', 'p1:u:1'],
    ['close with a stray argument', 'p1:x:1'],
    ['set missing the delivery', 'p1:s:contract'],
    ['empty segments', 'p1:::'],
    ['a path', 'p1:v:../../etc/passwd'],
    ['sql-ish', "p1:v:home'; drop table tg_bot_chats;--"],
    ['html', 'p1:v:<b>home</b>'],
    ['over 64 bytes', `p1:v:${'a'.repeat(80)}`],
  ];

  for (const [label, raw] of rejected) {
    it(`rejects ${label}`, () => {
      expect(parsePanelAction(raw)).toBeNull();
    });
  }

  it('refuses per-event delivery on a class whose spec forbids it', () => {
    // The same rule parseAlertsCommand enforces for `/alerts on … now`, applied
    // at the callback door: a crafted token must not outrank a safety property
    // of the class.
    for (const type of ALERT_TYPES) {
      const token = `p1:s:${type}:instant`;
      if (ALERT_CATALOG[type].instantAllowed) {
        expect(parsePanelAction(token)).toEqual({ kind: 'set', type, delivery: 'instant' });
      } else {
        expect(parsePanelAction(token)).toBeNull();
      }
    }
  });

  it('accepts a hand-built token that IS well formed', () => {
    // The complement of the rejections: the whitelist is not simply "no".
    expect(parsePanelAction('p1:s:missedRunner:digest')).toEqual({
      kind: 'set',
      type: 'missedRunner',
      delivery: 'digest',
    });
  });
});

// ---------------------------------------------------------------------------

describe('authorization is decided per press', () => {
  const write: PanelAction = { kind: 'set', type: 'missedRunner', delivery: 'digest' };
  const read: PanelAction = { kind: 'view', view: 'alerts' };

  it('classifies the three state-changing actions as writes', () => {
    expect(isPanelWrite({ kind: 'set', type: 'contract', delivery: 'digest' })).toBe(true);
    expect(isPanelWrite({ kind: 'unmute' })).toBe(true);
    expect(isPanelWrite({ kind: 'close' })).toBe(true);
    expect(isPanelWrite({ kind: 'view', view: 'home' })).toBe(false);
    expect(isPanelWrite({ kind: 'refresh', view: 'home' })).toBe(false);
    // The confirmation card only warns; the subscribe on it is the `set`.
    expect(isPanelWrite({ kind: 'confirm', type: 'contract' })).toBe(false);
  });

  it('refuses everything in a chat outside the allowlist', () => {
    for (const action of [read, write]) {
      const verdict = decidePanelPress(action, actor({ chatAllowed: false, isAdmin: true }));
      expect(verdict).toMatchObject({ allow: false, reason: 'chat_not_allowed' });
    }
  });

  it('lets a group admin write', () => {
    expect(decidePanelPress(write, actor({ isAdmin: true }))).toEqual({ allow: true });
  });

  it('refuses a group member a write — the press, not the panel, is what counts', () => {
    // The panel may well have been opened by an admin. The presser is somebody
    // else, and this is the clause that stops them retuning the room.
    const verdict = decidePanelPress(write, actor({ isAdmin: false }));
    expect(verdict).toMatchObject({ allow: false, reason: 'not_admin' });
    expect(verdict.allow ? '' : verdict.message).toContain('admin');
  });

  it('refuses a group member unmute and close as well as subscribe', () => {
    for (const action of [{ kind: 'unmute' } as const, { kind: 'close' } as const]) {
      expect(decidePanelPress(action, actor({ isAdmin: false }))).toMatchObject({
        allow: false,
        reason: 'not_admin',
      });
    }
  });

  it('lets any group member read', () => {
    expect(decidePanelPress(read, actor({ isAdmin: false }))).toEqual({ allow: true });
    expect(
      decidePanelPress({ kind: 'refresh', view: 'home' }, actor({ isAdmin: false })),
    ).toEqual({ allow: true });
  });

  it('treats plain groups exactly like supergroups', () => {
    // Telegram upgrades one to the other without warning, so a rule that only
    // named 'supergroup' would silently open on the day a group was upgraded.
    expect(decidePanelPress(write, actor({ chatType: 'group', isAdmin: false }))).toMatchObject({
      allow: false,
    });
    expect(decidePanelPress(write, actor({ chatType: 'group', isAdmin: true }))).toEqual({
      allow: true,
    });
  });

  it('in a DM, the owner is the chat id and nobody else', () => {
    const dm = actor({ chatId: 4242, chatType: 'private', userId: 4242, isAdmin: false });
    expect(decidePanelPress(write, dm)).toEqual({ allow: true });
    expect(decidePanelPress(write, { ...dm, userId: 99 })).toMatchObject({
      allow: false,
      reason: 'not_owner',
    });
  });

  it('admin status is never inferred from anything but the isAdmin fact', () => {
    // A guard against the failure mode this whole rule exists for: callbacks.ts
    // resolves isAdmin=false whenever getChatMember failed, and that must land
    // as a refusal rather than as a "probably fine".
    expect(decidePanelPress(write, actor({ isAdmin: false }))).toMatchObject({ allow: false });
  });
});

// ---------------------------------------------------------------------------

describe('the panel degrades rather than failing to render', () => {
  it('renders with no roster row, marking storage-backed fields unknown', () => {
    const card = renderPanelHome(state({ record: null, settings: panelHomeSettings(), alertsRouted: null }), null);
    expect(card).toContain('unknown');
    // And it still renders the parts it can answer from memory.
    expect(card).toContain('digest every 10 min');
  });

  it('still draws a full keyboard with no roster row', () => {
    const keyboard = buildPanelKeyboard(state({ record: null }));
    expect(keyboard.inline_keyboard.flat().length).toBeGreaterThan(4);
  });

  it('status says so out loud rather than reporting a healthy-looking chat', () => {
    expect(renderPanelStatus(state({ record: null }))).toContain('no OCT registration');
  });

  it('omits the Resources block when no console URL is configured', () => {
    expect(renderPanelHome(state(), null)).not.toContain('Resources');
    expect(renderPanelHome(state(), 'https://example.test/dashboard')).toContain('Resources');
  });

  it('ignores a console URL that is not http(s)', () => {
    // An inline-keyboard or anchor URL of tg:// can perform in-app navigation,
    // and a bad one is a 400 that would cost the whole panel.
    expect(readConsoleUrl({ TG_BOT_CONSOLE_URL: 'tg://resolve?domain=x' })).toBeNull();
    expect(readConsoleUrl({ TG_BOT_CONSOLE_URL: 'https://ok.test' })).toBe('https://ok.test');
  });

  it('renders every view without throwing, in the emptiest possible state', () => {
    for (const view of ['home', 'alerts', 'digest', 'recent', 'status', 'help'] as const) {
      const card = renderPanelView(state({ view, record: null, alertsRouted: null }), null);
      expect(card.length).toBeGreaterThan(0);
    }
  });
});

describe('the Queued card reads the digest buffer without draining it', () => {
  it('peek is non-destructive, unlike take', () => {
    const buffer = new DigestBuffer();
    const entry = { type: 'missedRunner' as const, key: 'k', line: 'a line' };
    buffer.add(1, entry, 0);
    buffer.add(1, entry, 1);

    expect(buffer.peek(1).lines).toEqual([{ type: 'missedRunner', line: 'a line', count: 2 }]);
    // Still there — rendering a card must never swallow a pending digest.
    expect(buffer.size(1)).toBe(1);
    expect(buffer.take(1)?.lines).toHaveLength(1);
    expect(buffer.peek(1).lines).toEqual([]);
  });

  it('says nothing is queued because nothing is subscribed, when that is why', () => {
    // A genuinely-unsubscribed chat: OCT Alerts is on by default, so this test
    // turns it off to reach the "subscribed to nothing" branch.
    expect(renderPanelRecent(state({ settings: settings({ octSignals: 'off' }) }))).toContain(
      'subscribed to nothing',
    );
    expect(renderPanelRecent(state({ settings: settings({ missedRunner: 'digest' }) }))).toContain(
      'Nothing buffered',
    );
  });
});
