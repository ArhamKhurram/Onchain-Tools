import { describe, it, expect } from 'vitest';
import {
  buildPreviewSeed,
  buildPreviewStreamEvent,
  buildPreviewConfig,
  PREVIEW_ROOM_ALPHA,
  PREVIEW_ROOM_RUNNERS,
} from '../src/preview/previewFeed';

// The preview feed is what a brand-new, un-connected user watches before the
// Discord-token ask (the #1 activation fix). The seed + stream generators are
// PURE given (now, seq) precisely so this behaviour is pinned down here — the
// feed must look real (CAs, tiers, market caps, ordering) and stay deterministic
// so the onboarding never flickers or renders a broken row.

const NOW = 1_700_000_000_000; // fixed clock

describe('buildPreviewSeed', () => {
  it('is deterministic given a fixed clock', () => {
    expect(buildPreviewSeed(NOW)).toEqual(buildPreviewSeed(NOW));
  });

  it('seeds both preview rooms with message history', () => {
    const seed = buildPreviewSeed(NOW);
    expect(Object.keys(seed.messages).sort()).toEqual(
      [PREVIEW_ROOM_ALPHA, PREVIEW_ROOM_RUNNERS].sort(),
    );
    expect(seed.messages[PREVIEW_ROOM_ALPHA].length).toBeGreaterThan(0);
    expect(seed.messages[PREVIEW_ROOM_RUNNERS].length).toBeGreaterThan(0);
  });

  it('opens on the alpha room and pins one pane to it', () => {
    const seed = buildPreviewSeed(NOW);
    expect(seed.activeRoomId).toBe(PREVIEW_ROOM_ALPHA);
    expect(seed.paneRoomIds).toEqual([PREVIEW_ROOM_ALPHA]);
  });

  it('orders messages oldest-first and contracts newest-first', () => {
    const seed = buildPreviewSeed(NOW);
    const ts = (s: string) => new Date(s).getTime();

    for (const msgs of Object.values(seed.messages)) {
      for (let i = 1; i < msgs.length; i++) {
        expect(ts(msgs[i].timestamp)).toBeGreaterThanOrEqual(ts(msgs[i - 1].timestamp));
      }
    }
    for (let i = 1; i < seed.contracts.length; i++) {
      expect(ts(seed.contracts[i].timestamp)).toBeLessThanOrEqual(ts(seed.contracts[i - 1].timestamp));
    }
  });

  it('produces enriched, believable contract rows (symbol, name, market cap, chain)', () => {
    const seed = buildPreviewSeed(NOW);
    expect(seed.contracts.length).toBeGreaterThan(0);
    for (const c of seed.contracts) {
      expect(c.tokenSymbol).toBeTruthy();
      expect(c.tokenName).toBeTruthy();
      expect(c.firstCallMcapUsd).toBeGreaterThan(0);
      expect(c.fdvAtCallDisplay).toMatch(/^\$/);
      expect(['sol', 'evm']).toContain(c.chain);
      if (c.chain === 'evm') expect(c.evmChain).toBeTruthy();
    }
  });

  it('every seeded CA message references a real seeded contract', () => {
    const seed = buildPreviewSeed(NOW);
    const addrs = new Set(seed.contracts.map((c) => c.address));
    const caMessages = Object.values(seed.messages)
      .flat()
      .filter((m) => m.hasContractAddress);
    expect(caMessages.length).toBeGreaterThan(0);
    for (const m of caMessages) {
      expect(m.contractAddresses.length).toBeGreaterThan(0);
      for (const a of m.contractAddresses) expect(addrs.has(a)).toBe(true);
    }
  });

  it('carries no real Discord tokens in the preview config', () => {
    const cfg = buildPreviewConfig();
    expect(cfg.discordTokens).toEqual([]);
    expect(cfg.rooms.length).toBeGreaterThan(0);
    expect(cfg.callerTiers.length).toBeGreaterThan(0);
  });
});

describe('buildPreviewStreamEvent', () => {
  it('is pure given (seq, now)', () => {
    expect(buildPreviewStreamEvent(3, NOW)).toEqual(buildPreviewStreamEvent(3, NOW));
  });

  it('cycles the pool so the feed keeps flowing indefinitely', () => {
    const a = buildPreviewStreamEvent(0, NOW);
    const b = buildPreviewStreamEvent(1, NOW);
    expect(a.message.id).not.toBe(b.message.id);
    // Wraps: seq N and seq N+period map to the same pool entry (same content).
    let period = 1;
    while (period < 50 && buildPreviewStreamEvent(period, NOW).message.content !== a.message.content) {
      period++;
    }
    expect(period).toBeLessThan(50);
    expect(buildPreviewStreamEvent(period, NOW).message.content).toBe(a.message.content);
  });

  it('token-carrying events include an enriched contract; chatter does not', () => {
    // Sweep one full pool period so we exercise both branches.
    let sawContract = false;
    let sawChatter = false;
    for (let seq = 0; seq < 20; seq++) {
      const ev = buildPreviewStreamEvent(seq, NOW);
      expect(ev.roomIds.length).toBeGreaterThan(0);
      if (ev.contract) {
        sawContract = true;
        expect(ev.message.hasContractAddress).toBe(true);
        expect(ev.message.contractAddresses).toContain(ev.contract.address);
        expect(ev.contract.firstCallMcapUsd).toBeGreaterThan(0);
      } else {
        sawChatter = true;
        expect(ev.message.hasContractAddress).toBe(false);
      }
    }
    expect(sawContract).toBe(true);
    expect(sawChatter).toBe(true);
  });

  it('stamps stream events at `now`', () => {
    const ev = buildPreviewStreamEvent(0, NOW);
    expect(new Date(ev.message.timestamp).getTime()).toBe(NOW);
  });
});
