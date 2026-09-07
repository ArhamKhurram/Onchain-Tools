// The delivery policy, as pure functions.
//
// These exist because of a production incident: the bot was wired to contract
// detections — OCT's highest-volume event class — with the subscription ON by
// default, and it flooded the first real group it was added to. Every test
// below pins one of the properties that stops that happening again.

import { describe, it, expect } from 'vitest';
import {
  ALERT_CATALOG,
  ALERT_TYPES,
  applyAlertSetting,
  applyMute,
  classifyAlert,
  clearMute,
  DEFAULT_CHAT_SETTINGS,
  findAlertType,
  isMuted,
  parseAlertsCommand,
  readSettings,
  subscribedTypes,
  type AlertLike,
  type TgAlertType,
} from '../src/tgbot/alertPolicy';
import { ChatOutboundGuard, DEFAULT_GUARD_LIMITS } from '../src/tgbot/guard';
import { DigestBuffer } from '../src/tgbot/digest';
import { renderAlertSettings, renderDigest, renderVolumeWarning } from '../src/tgbot/render';

const alert = (type: string, over: Record<string, unknown> = {}): AlertLike => ({
  type,
  reason: `${type} fired`,
  message: { hasContractAddress: false, contractAddresses: [], ...over } as never,
});

// ---------------------------------------------------------------------------

describe('fail closed: what a brand-new chat is subscribed to', () => {
  // The five INCIDENT classes — everything except octSignals. The fail-closed
  // guarantee is stated over these: a bot added to somebody's group must be
  // silent on the raw feed until a human deliberately turns something on.
  const INCIDENT: TgAlertType[] = ['missedRunner', 'mcapCross', 'keyword', 'highlighted', 'contract'];

  // THE test. /start passes no settings at all, so this constant IS what a
  // freshly registered chat gets: every incident class off. octSignals ("OCT
  // Alerts") is the ONE deliberate exception — a curated, operator-controlled
  // stream that is on (instant) by default on the operator's explicit
  // instruction, and stays a normal toggle.
  it('/start leaves every incident class off, and only OCT Alerts on', () => {
    expect(subscribedTypes(DEFAULT_CHAT_SETTINGS)).toEqual(['octSignals']);
    for (const type of INCIDENT) {
      expect(DEFAULT_CHAT_SETTINGS.alerts[type]).toBe('off');
    }
    expect(DEFAULT_CHAT_SETTINGS.alerts.octSignals).toBe('instant');
  });

  // The default-on flows to EXISTING chats too: their stored blobs predate the
  // key, so an absent key must read as instant. That is how every current
  // subscriber starts receiving it with no migration.
  const onlyOctSignals = (raw: unknown): void => {
    expect(subscribedTypes(readSettings(raw))).toEqual(['octSignals']);
    expect(readSettings(raw).alerts.octSignals).toBe('instant');
    for (const type of INCIDENT) expect(readSettings(raw).alerts[type]).toBe('off');
  };

  it('an absent, null or empty settings blob reads as OCT Alerts on, everything else off', () => {
    onlyOctSignals(undefined);
    onlyOctSignals(null);
    onlyOctSignals({});
    onlyOctSignals({ alerts: {} });
  });

  it('a row written by the OLD build comes back with no incident subscription', () => {
    // `{ contractAlerts: true }` is exactly the subscription that flooded a
    // live group. It is deliberately not migrated — it is ignored, so every
    // chat registered under the old build has to opt into the feed again.
    onlyOctSignals({ contractAlerts: true });
  });

  it('garbage in the blob cannot switch an incident class on', () => {
    onlyOctSignals({ alerts: { contract: 'on' } });
    onlyOctSignals({ alerts: { contract: true } });
    onlyOctSignals({ alerts: { nonsense: 'digest' } });
    onlyOctSignals('all');
  });

  it('an explicit off silences even OCT Alerts — it stays a normal toggle', () => {
    expect(subscribedTypes(readSettings({ alerts: { octSignals: 'off' } }))).toEqual([]);
  });

  it('demotes a stored instant on a class that no longer permits it', () => {
    // A safety property of the class must outrank a stored preference.
    expect(readSettings({ alerts: { contract: 'instant' } }).alerts.contract).toBe('digest');
    expect(readSettings({ alerts: { missedRunner: 'instant' } }).alerts.missedRunner).toBe('instant');
  });
});

describe('alert classification', () => {
  it('maps the four types that actually reach the onAlert seam', () => {
    expect(classifyAlert(alert('contract_address'))).toBe('contract');
    expect(classifyAlert(alert('highlighted_user'))).toBe('highlighted');
    expect(classifyAlert(alert('keyword_match'))).toBe('keyword');
    expect(classifyAlert(alert('missed_runner'))).toBe('missedRunner');
  });

  it('treats a highlighted user WITH a contract as a contract detection', () => {
    // frontendAlerts.ts emits highlighted_user and returns, so this is the
    // only way that detection reaches us — and it is a contract detection,
    // which means it is governed by the contract subscription, not the
    // quieter highlighted one.
    expect(classifyAlert(alert('highlighted_user', { hasContractAddress: true }))).toBe('contract');
  });

  it('refuses to classify anything it has not decided a volume for', () => {
    // signal_convergence is raised client-side and never reaches the backend;
    // revival/breakout and pump_callout/fomo_trade use their own frames. None
    // of them arrive here, and guessing would be how the next flood starts.
    expect(classifyAlert(alert('signal_convergence'))).toBeNull();
    expect(classifyAlert(alert('revival_alert'))).toBeNull();
    expect(classifyAlert(alert('pump_callout'))).toBeNull();
    expect(classifyAlert(alert('something_new'))).toBeNull();
  });
});

describe('the alert catalog', () => {
  it('permits per-event delivery ONLY where upstream volume is bounded', () => {
    // missedRunner is rare by construction (3-min poll, 24h per-token
    // cooldown). The other three track the feed and are bounded by nothing,
    // so a chat cannot ask for one message per event.
    expect(ALERT_CATALOG.missedRunner.instantAllowed).toBe(true);
    expect(ALERT_CATALOG.contract.instantAllowed).toBe(false);
    expect(ALERT_CATALOG.highlighted.instantAllowed).toBe(false);
    expect(ALERT_CATALOG.keyword.instantAllowed).toBe(false);
  });

  it('makes contract detections the one class that costs a second command', () => {
    expect(ALERT_CATALOG.contract.requiresConfirmation).toBe(true);
    expect(ALERT_CATALOG.missedRunner.requiresConfirmation).toBe(false);
  });

  it('resolves every keyword and alias a user might type', () => {
    expect(findAlertType('runners')?.type).toBe('missedRunner');
    expect(findAlertType('MISSED')?.type).toBe('missedRunner');
    expect(findAlertType('  ca ')?.type).toBe('contract');
    expect(findAlertType('contracts')?.type).toBe('contract');
    expect(findAlertType('')).toBeNull();
    expect(findAlertType('everything')).toBeNull();
  });
});

describe('/alerts parsing', () => {
  it('shows the board for a bare command', () => {
    expect(parseAlertsCommand([])).toEqual({ kind: 'show' });
    expect(parseAlertsCommand(['show'])).toEqual({ kind: 'show' });
  });

  it('opts in as a DIGEST by default, never per-event', () => {
    const action = parseAlertsCommand(['on', 'runners']);
    expect(action).toMatchObject({ kind: 'set', delivery: 'digest', confirmed: false });
  });

  it('opts out', () => {
    expect(parseAlertsCommand(['off', 'contracts'])).toMatchObject({
      kind: 'set',
      delivery: 'off',
    });
  });

  it('accepts per-event delivery only where the class allows it', () => {
    expect(parseAlertsCommand(['on', 'runners', 'now'])).toMatchObject({ delivery: 'instant' });
    // Refused outright rather than quietly downgraded: a chat that asked for
    // every event and silently got a digest would think the bot was broken.
    expect(parseAlertsCommand(['on', 'contracts', 'now'])).toMatchObject({ kind: 'usage' });
  });

  it('reads the confirmation word in either order', () => {
    expect(parseAlertsCommand(['on', 'runners', 'now', 'confirm'])).toMatchObject({
      delivery: 'instant',
      confirmed: true,
    });
    expect(parseAlertsCommand(['on', 'contracts', 'confirm'])).toMatchObject({
      delivery: 'digest',
      confirmed: true,
    });
  });

  it('parses unmute', () => {
    expect(parseAlertsCommand(['unmute'])).toEqual({ kind: 'unmute' });
  });

  it('names the specific problem rather than a generic error', () => {
    expect(parseAlertsCommand(['sideways'])).toMatchObject({ kind: 'usage' });
    expect(parseAlertsCommand(['on'])).toMatchObject({ kind: 'usage' });
    const bad = parseAlertsCommand(['on', 'everything']);
    expect(bad.kind).toBe('usage');
    if (bad.kind === 'usage') expect(bad.problem).toContain('everything');
  });
});

describe('settings transitions', () => {
  it('round-trips an opt-in through JSON without leaking the other classes', () => {
    // octSignals is on by default, so an opt-in to another class shows both.
    const next = applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'missedRunner', 'digest');
    const stored = readSettings(JSON.parse(JSON.stringify(next)));
    expect(subscribedTypes(stored)).toEqual(['octSignals', 'missedRunner']);
    expect(stored.alerts.contract).toBe('off');
  });

  it('round-trips an opt-out back to the default (OCT Alerts only)', () => {
    const on = applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'digest');
    const off = applyAlertSetting(on, 'contract', 'off');
    expect(subscribedTypes(readSettings(JSON.parse(JSON.stringify(off))))).toEqual(['octSignals']);
  });

  it('never mutates the settings it was handed', () => {
    // DEFAULT_CHAT_SETTINGS is a module constant shared by every new chat.
    applyAlertSetting(DEFAULT_CHAT_SETTINGS, 'contract', 'instant');
    expect(DEFAULT_CHAT_SETTINGS.alerts.contract).toBe('off');
  });

  it('round-trips a mute and its removal', () => {
    const muted = applyMute(DEFAULT_CHAT_SETTINGS, 5_000, '40 alerts in under a minute');
    expect(isMuted(muted, 4_999)).toBe(true);
    expect(isMuted(muted, 5_001)).toBe(false);
    const stored = readSettings(JSON.parse(JSON.stringify(muted)));
    expect(stored.mutedUntil).toBe(5_000);
    expect(stored.mutedReason).toBe('40 alerts in under a minute');
    expect(isMuted(clearMute(stored), 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('ChatOutboundGuard — the hourly ceiling', () => {
  const limits = { ...DEFAULT_GUARD_LIMITS, maxPerHour: 3, ceilingWindowMs: 1000 };

  it('ships a conservative default', () => {
    expect(DEFAULT_GUARD_LIMITS.maxPerHour).toBeLessThanOrEqual(10);
    expect(DEFAULT_GUARD_LIMITS.ceilingWindowMs).toBe(3_600_000);
  });

  it('allows sends under the ceiling', () => {
    const guard = new ChatOutboundGuard(limits);
    expect(guard.admitSend(1, 0, 0).allow).toBe(true);
    expect(guard.admitSend(1, 1, 0).allow).toBe(true);
    expect(guard.admitSend(1, 2, 0).allow).toBe(true);
  });

  it('DROPS over the ceiling — it does not queue or delay', () => {
    const guard = new ChatOutboundGuard(limits);
    for (let i = 0; i < 3; i += 1) guard.admitSend(1, i, 0);
    const refused = guard.admitSend(1, 3, 0);
    expect(refused.allow).toBe(false);
    expect(refused.reason).toBe('ceiling');
    expect(refused.used).toBe(3);
    expect(refused.limit).toBe(3);
  });

  it('resets across windows, as a sliding window rather than a bucket', () => {
    const guard = new ChatOutboundGuard(limits);
    guard.admitSend(1, 0, 0);
    guard.admitSend(1, 500, 0);
    guard.admitSend(1, 900, 0);
    expect(guard.admitSend(1, 950, 0).allow).toBe(false);
    // The first send ages out at t=1001, freeing exactly one slot.
    expect(guard.admitSend(1, 1001, 0).allow).toBe(true);
    expect(guard.admitSend(1, 1002, 0).allow).toBe(false);
  });

  it('meters each chat separately', () => {
    const guard = new ChatOutboundGuard({ ...limits, maxPerHour: 1 });
    expect(guard.admitSend(1, 0, 0).allow).toBe(true);
    expect(guard.admitSend(2, 0, 0).allow).toBe(true);
    expect(guard.admitSend(1, 0, 0).allow).toBe(false);
  });

  it('refuses a muted chat without spending its budget', () => {
    const guard = new ChatOutboundGuard(limits);
    const refused = guard.admitSend(1, 100, 5_000);
    expect(refused.allow).toBe(false);
    expect(refused.reason).toBe('muted');
    expect(guard.usedThisHour(1, 100)).toBe(0);
  });

  it('forgets idle chats so the map cannot grow forever', () => {
    const guard = new ChatOutboundGuard(limits);
    guard.admitSend(1, 0, 0);
    guard.prune(50_000);
    expect(guard.usedThisHour(1, 50_000)).toBe(0);
  });
});

describe('ChatOutboundGuard — the circuit breaker', () => {
  const limits = {
    ...DEFAULT_GUARD_LIMITS,
    breakerMaxEvents: 3,
    breakerWindowMs: 1000,
    breakerMuteMs: 60_000,
  };

  it('stays quiet under the threshold', () => {
    const guard = new ChatOutboundGuard(limits);
    expect(guard.noteEvent(1, 0).tripped).toBe(false);
    expect(guard.noteEvent(1, 1).tripped).toBe(false);
  });

  it('trips on the threshold event and asks for a mute', () => {
    const guard = new ChatOutboundGuard(limits);
    guard.noteEvent(1, 0);
    guard.noteEvent(1, 1);
    const tripped = guard.noteEvent(1, 2);
    expect(tripped.tripped).toBe(true);
    expect(tripped.events).toBe(3);
    expect(tripped.muteUntil).toBe(2 + 60_000);
  });

  it('trips ONCE, not on every subsequent event', () => {
    // Re-tripping per event would roll the mute forward forever and fill the
    // log with the same line.
    const guard = new ChatOutboundGuard(limits);
    guard.noteEvent(1, 0);
    guard.noteEvent(1, 1);
    expect(guard.noteEvent(1, 2).tripped).toBe(true);
    expect(guard.noteEvent(1, 3).tripped).toBe(false);
    expect(guard.noteEvent(1, 4).tripped).toBe(false);
  });

  it('does not clear another chat\'s progress when one trips', () => {
    const guard = new ChatOutboundGuard(limits);
    // Both chats two events in, neither tripped.
    for (const chat of [1, 2]) {
      expect(guard.noteEvent(chat, 0).tripped).toBe(false);
      expect(guard.noteEvent(chat, 1).tripped).toBe(false);
    }
    // Chat 1's third event trips it and clears ITS window only — chat 2 still
    // needs exactly one more, which it gets.
    expect(guard.noteEvent(1, 2).tripped).toBe(true);
    expect(guard.noteEvent(2, 2).tripped).toBe(true);
  });

  it('counts events, not deliveries — which is what makes it fire at all', () => {
    // With the ceiling clamping deliveries to a tidy handful per hour, a
    // breaker on deliveries could never trip. Counting attempts is what makes
    // an upstream mis-specification visible.
    const guard = new ChatOutboundGuard({ ...limits, maxPerHour: 1 });
    guard.admitSend(1, 0, 0);
    expect(guard.admitSend(1, 1, 0).allow).toBe(false);
    guard.noteEvent(1, 0);
    guard.noteEvent(1, 1);
    expect(guard.noteEvent(1, 2).tripped).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('DigestBuffer', () => {
  const entry = (key: string, line = key) => ({ type: 'contract' as const, key, line });

  it('collapses N events into ONE pending digest', () => {
    const buffer = new DigestBuffer();
    for (let i = 0; i < 8; i += 1) buffer.add(-100, entry(`a${i}`), i);
    expect(buffer.pendingChats()).toEqual([-100]);
    const taken = buffer.take(-100);
    expect(taken?.lines).toHaveLength(8);
  });

  it('coalesces a repeated key into one line with a count', () => {
    const buffer = new DigestBuffer();
    for (let i = 0; i < 5; i += 1) buffer.add(-100, entry('same'), i);
    const taken = buffer.take(-100);
    expect(taken?.lines).toHaveLength(1);
    expect(taken?.lines[0]?.count).toBe(5);
  });

  it('produces nothing for an empty window', () => {
    const buffer = new DigestBuffer();
    expect(buffer.pendingChats()).toEqual([]);
    expect(buffer.take(-100)).toBeNull();
  });

  it('is empty again after a take, so the next window starts clean', () => {
    const buffer = new DigestBuffer();
    buffer.add(-100, entry('a'), 0);
    buffer.take(-100);
    expect(buffer.pendingChats()).toEqual([]);
    expect(buffer.take(-100)).toBeNull();
  });

  it('caps a chat and counts what it dropped rather than growing', () => {
    const buffer = new DigestBuffer(3);
    expect(buffer.add(-100, entry('a'), 0)).toBe(true);
    expect(buffer.add(-100, entry('b'), 0)).toBe(true);
    expect(buffer.add(-100, entry('c'), 0)).toBe(true);
    expect(buffer.add(-100, entry('d'), 0)).toBe(false);
    expect(buffer.size(-100)).toBe(3);
    const taken = buffer.take(-100);
    expect(taken?.dropped).toBe(1);
  });

  it('still accepts a repeat of a key it already holds when full', () => {
    // It costs no new line, and refusing it would lose the count on a line we
    // are sending anyway.
    const buffer = new DigestBuffer(1);
    buffer.add(-100, entry('a'), 0);
    expect(buffer.add(-100, entry('a'), 1)).toBe(true);
    expect(buffer.add(-100, entry('b'), 1)).toBe(false);
  });

  it('buffers each chat separately', () => {
    const buffer = new DigestBuffer();
    buffer.add(-100, entry('a'), 0);
    buffer.add(-200, entry('b'), 0);
    expect(buffer.pendingChats().sort((a, b) => a - b)).toEqual([-200, -100]);
    buffer.discard(-100);
    expect(buffer.pendingChats()).toEqual([-200]);
  });
});

describe('digest rendering', () => {
  it('renders one message with a count per coalesced line', () => {
    const out = renderDigest(
      {
        chatId: -100,
        since: 0,
        dropped: 2,
        lines: [
          { type: 'contract', line: '<code>abc</code>', count: 3 },
          { type: 'keyword', line: 'Keyword matches — moon', count: 1 },
        ],
      },
      600_000,
    );
    expect(out).toContain('4 alerts');
    expect(out).toContain('×3');
    expect(out).toContain('+2 more not shown');
    expect(out).toContain('Last 10 min');
    expect(out.length).toBeLessThanOrEqual(4096);
  });

  it('agrees with itself on a single alert', () => {
    const out = renderDigest(
      { chatId: -100, since: 0, dropped: 0, lines: [{ type: 'contract', line: 'x', count: 1 }] },
      60_000,
    );
    expect(out).toContain('1 alert');
    expect(out).not.toContain('1 alerts');
    expect(out).not.toContain('×');
  });
});

describe('the subscription board', () => {
  it('lists every class with its real volume, including the ones that are off', () => {
    const out = renderAlertSettings(DEFAULT_CHAT_SETTINGS, {
      digestMinutes: 10,
      maxPerHour: 10,
      now: 0,
    });
    for (const type of ALERT_TYPES) expect(out).toContain(ALERT_CATALOG[type].label);
    expect(out).toContain('10 messages an hour');
    expect(out).toContain('every 10 min');
  });

  it('warns about the volume before anyone can subscribe to contracts', () => {
    const out = renderVolumeWarning('contract');
    expect(out).toContain('loudest');
    expect(out).toContain('/alerts on contracts confirm');
  });
});
