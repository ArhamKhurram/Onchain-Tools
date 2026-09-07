// The panel's Filters view and the linked/unlinked states of the cards.
//
// TWO THINGS ARE WORTH PINNING HERE.
//
//  1. THE VIEW IS DRIVEN BY THE DEFINITION TABLE, NOT BY A LIST. There is a
//     second agent adding fields to `mcapCross/filters.ts` right now, so the
//     tests below assert against `MCAP_CROSS_FILTER_KEYS` itself: a filter added
//     to that table must gain a row, a button and a working token with no edit
//     to the bot. A test that named the four fields would pass while the panel
//     silently hid the fifth.
//
//  2. A CALLBACK TOKEN CARRYING A NUMBER IS UNTRUSTED INPUT. The buttons are
//     drawn from a validated ladder, but Telegram echoes whatever byte string a
//     crafted client sends. `parsePanelAction` runs the SAME validator the HTTP
//     boundary runs, so a threshold the console would reject cannot arrive
//     through a button either.

import { describe, it, expect } from 'vitest';
import { DEFAULT_CHAT_SETTINGS, type TgChatSettings } from '../src/tgbot/alertPolicy';
import type { TgChatRecord } from '../src/tgbot/chatStore';
import {
  MCAP_CROSS_FILTER_BOUNDS,
  MCAP_CROSS_FILTER_KEYS,
  validateFilterPatch,
} from '../src/mcapCross/filters';
import {
  asFilterKey,
  filterLadder,
  filterLabel,
  filterLines,
  formatFilterValue,
  parseFilterValue,
} from '../src/tgbot/filtersView';
import {
  allPanelActions,
  buildFilterKeyboard,
  buildPanelKeyboard,
  decidePanelPress,
  encodePanelAction,
  feedLine,
  isPanelWrite,
  MAX_CALLBACK_DATA_BYTES,
  parsePanelAction,
  renderPanelFilters,
  renderPanelStatus,
  renderPanelHome,
  type PanelActor,
  type PanelState,
} from '../src/tgbot/panel';
import { accountFingerprint } from '../src/tgbot/identity';

const ALICE = 'aaaaaaaa-1111-2222-3333-444444444444';

const settings = (): TgChatSettings => ({
  ...DEFAULT_CHAT_SETTINGS,
  alerts: { ...DEFAULT_CHAT_SETTINGS.alerts },
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
  view: 'filters',
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
  now: Date.parse('2026-09-08T12:34:56.000Z'),
  ...over,
});

const lines = (stored: Record<string, number> = {}) => {
  const numeric: Record<string, number> = {};
  for (const key of MCAP_CROSS_FILTER_KEYS) numeric[key] = 1234;
  return filterLines(stored, numeric, numeric);
};

const boundState = (stored: Record<string, number> = {}) =>
  state({
    boundAccount: accountFingerprint(ALICE),
    record: record({ sourceUserId: ALICE }),
    filters: { unavailable: false, lines: lines(stored), overrideCount: Object.keys(stored).length },
  });

// ---------------------------------------------------------------------------

describe('the filter view follows the definition table', () => {
  it('lists every key the table declares, by the table’s own label', () => {
    const card = renderPanelFilters(boundState());
    for (const key of MCAP_CROSS_FILTER_KEYS) {
      expect(card).toContain(MCAP_CROSS_FILTER_BOUNDS[key].label);
    }
  });

  it('draws one button per key, none invented', () => {
    const keyboard = buildPanelKeyboard(boundState());
    const tokens = keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? '');
    const opened = tokens
      .map((t) => parsePanelAction(t))
      .filter((a): a is Extract<ReturnType<typeof parsePanelAction>, { kind: 'filter' }> =>
        a?.kind === 'filter',
      )
      .map((a) => a.key);
    expect(opened).toEqual([...MCAP_CROSS_FILTER_KEYS]);
  });

  it('offers only rungs the shared validator accepts', () => {
    for (const key of MCAP_CROSS_FILTER_KEYS) {
      const ladder = filterLadder(key);
      expect(ladder.length).toBeGreaterThan(0);
      for (const value of ladder) {
        expect(validateFilterPatch({ [key]: value }).ok).toBe(true);
      }
    }
  });

  it('never renders a zero ceiling — a mute switch wearing a threshold’s clothes', () => {
    for (const key of MCAP_CROSS_FILTER_KEYS) {
      if (MCAP_CROSS_FILTER_BOUNDS[key].direction !== 'max') continue;
      expect(filterLadder(key)).not.toContain(0);
    }
  });

  it('renders values by the table’s unit, and never restates a label', () => {
    for (const key of MCAP_CROSS_FILTER_KEYS) {
      expect(filterLabel(key)).toBe(MCAP_CROSS_FILTER_BOUNDS[key].label);
      const shown = formatFilterValue(key, 0.05);
      expect(shown).toBe(MCAP_CROSS_FILTER_BOUNDS[key].unit === 'fraction' ? '5%' : '$0');
    }
  });

  it('keeps every filter token inside Telegram’s 64-byte cap', () => {
    for (const action of allPanelActions()) {
      expect(Buffer.byteLength(encodePanelAction(action), 'utf8')).toBeLessThanOrEqual(
        MAX_CALLBACK_DATA_BYTES,
      );
    }
    for (const key of MCAP_CROSS_FILTER_KEYS) {
      for (const button of buildFilterKeyboard(key).inline_keyboard.flat()) {
        expect(Buffer.byteLength(button.callback_data ?? '', 'utf8')).toBeLessThanOrEqual(
          MAX_CALLBACK_DATA_BYTES,
        );
      }
    }
  });
});

describe('filter tokens are untrusted', () => {
  it('round-trips everything a keyboard can emit', () => {
    for (const action of allPanelActions()) {
      expect(parsePanelAction(encodePanelAction(action))).toEqual(action);
    }
  });

  it('refuses a crafted value the console would refuse', () => {
    // 150 on a fraction ceiling is the "typed a percent" mistake; a crafted
    // press must not get past the bound just because it skipped the ladder.
    const ceiling = MCAP_CROSS_FILTER_KEYS.find(
      (k) => MCAP_CROSS_FILTER_BOUNDS[k].unit === 'fraction',
    );
    expect(ceiling).toBeDefined();
    expect(parsePanelAction(`p1:fv:${ceiling}:150`)).toBeNull();
    expect(parsePanelAction(`p1:fv:${ceiling}:-1`)).toBeNull();
    expect(parsePanelAction(`p1:fv:${ceiling}:NaN`)).toBeNull();
  });

  it('refuses a filter name that is not in the table', () => {
    expect(parsePanelAction('p1:fk:notAFilter')).toBeNull();
    expect(parsePanelAction('p1:fv:notAFilter:5')).toBeNull();
    expect(asFilterKey('notAFilter')).toBeNull();
  });

  it('treats a threshold write as a write, and the warning card as a read', () => {
    const key = MCAP_CROSS_FILTER_KEYS[0]!;
    expect(isPanelWrite({ kind: 'filterSet', key, value: null })).toBe(true);
    expect(isPanelWrite({ kind: 'unlinkConfirm' })).toBe(true);
    expect(isPanelWrite({ kind: 'filter', key })).toBe(false);
    expect(isPanelWrite({ kind: 'unlink' })).toBe(false);
    expect(isPanelWrite({ kind: 'view', view: 'filters' })).toBe(false);
  });

  it('needs group admin to store a threshold or to unlink', () => {
    const key = MCAP_CROSS_FILTER_KEYS[0]!;
    const member: PanelActor = {
      chatId: -100123,
      chatType: 'supergroup',
      userId: 99,
      chatAllowed: true,
      isAdmin: false,
    };
    expect(decidePanelPress({ kind: 'filterSet', key, value: 5000 }, member).allow).toBe(false);
    expect(decidePanelPress({ kind: 'unlinkConfirm' }, member).allow).toBe(false);
    expect(
      decidePanelPress({ kind: 'filterSet', key, value: 5000 }, { ...member, isAdmin: true }).allow,
    ).toBe(true);
  });

  it('has no single token that unbinds a chat', () => {
    const oneTap = allPanelActions().filter((a) => a.kind === 'unlinkConfirm');
    // The token exists — but only the WARNING card renders it, never the panel.
    const keyboard = buildPanelKeyboard(
      boundState() as PanelState,
    ).inline_keyboard.flat();
    expect(oneTap).toHaveLength(1);
    expect(keyboard.some((b) => b.callback_data === 'p1:ulc')).toBe(false);
  });
});

describe('what the cards say before and after linking', () => {
  it('says nothing is bound, and how to fix it', () => {
    const unlinked = state({ view: 'home', alertsRouted: false });
    expect(feedLine(unlinked)).toContain('no alert source bound yet');
    expect(renderPanelHome(unlinked, null)).toContain('/link');
  });

  it('distinguishes the instance default from an actual link', () => {
    // Alerts flow, but nothing is bound: /unlink does nothing here and there is
    // no account whose filters this chat may edit.
    expect(feedLine(state({ alertsRouted: true, boundAccount: null }))).toContain(
      'instance default',
    );
  });

  it('names the bound account by fingerprint, never by anything sensitive', () => {
    const linked = boundState();
    const status = renderPanelStatus({ ...linked, view: 'status' });
    expect(status).toContain('#aaaaaaaa');
    expect(status).not.toContain(ALICE);
    expect(status).not.toContain('@');
    expect(feedLine(linked)).toContain('linked to OCT account #aaaaaaaa');
  });

  it('offers no filter buttons and explains itself when nothing is linked', () => {
    const card = renderPanelFilters(state({ alertsRouted: false }));
    expect(card).toContain('/link');
    const keyboard = buildPanelKeyboard(state({ alertsRouted: false }));
    expect(
      keyboard.inline_keyboard.flat().some((b) => (b.callback_data ?? '').startsWith('p1:fk')),
    ).toBe(false);
  });

  it('offers the unlink button only on a linked chat’s status card', () => {
    const linked = buildPanelKeyboard({ ...boundState(), view: 'status' });
    const unlinked = buildPanelKeyboard(state({ view: 'status' }));
    expect(linked.inline_keyboard.flat().some((b) => b.callback_data === 'p1:ul')).toBe(true);
    expect(unlinked.inline_keyboard.flat().some((b) => b.callback_data === 'p1:ul')).toBe(false);
  });

  it('reports unknown rather than a confident "no" during an outage', () => {
    expect(feedLine(state({ record: null, alertsRouted: null }))).toBe('unknown');
  });

  it('says storage is down instead of showing thresholds that are not yours', () => {
    const card = renderPanelFilters({
      ...boundState(),
      filters: { unavailable: true, lines: [], overrideCount: 0 },
    });
    expect(card).toContain('unavailable');
  });
});

describe('the typed value parser is the shared validator', () => {
  it('accepts "inherit" as the only way to clear a filter', () => {
    const key = MCAP_CROSS_FILTER_KEYS[0]!;
    for (const word of ['inherit', 'default', 'clear', 'reset', 'INHERIT']) {
      expect(parseFilterValue(key, word)).toEqual({ ok: true, value: null });
    }
  });

  it('returns the validator’s errors verbatim rather than its own wording', () => {
    const key = MCAP_CROSS_FILTER_KEYS.find(
      (k) => MCAP_CROSS_FILTER_BOUNDS[k].unit === 'fraction',
    )!;
    const mine = parseFilterValue(key, '150');
    const theirs = validateFilterPatch({ [key]: 150 });
    expect(mine.ok).toBe(false);
    expect(theirs.ok).toBe(false);
    if (!mine.ok && !theirs.ok) expect(mine.errors).toEqual(theirs.errors);
  });
});
