// A re-delivered call must not reach the Contract Feed.
//
// The Telegram update stream replays a message after a reconnect or an
// update-gap recovery, minutes to hours later. #368 stopped that landing as a
// second DATABASE row, but ingest still broadcasts whatever `logContract`
// returns, so the console sees a `contract` frame for a call it has already
// shown. The backend now marks those frames `duplicate: true` and the store
// drops them.
//
// Dropping, not folding: the feed already collapses genuine repeat scans of one
// address into a single row with a "×N scans" badge
// (utils/contractFeedGrouping.ts), and a re-delivery is not a scan — it is the
// same call arriving twice over the transport. Folding it would put the
// inflation #368 removed from the database straight back into the badge.
//
// The store's pre-existing messageId+address guard is NOT a substitute: it only
// sees calls still inside the 2000-row cap, and the measured re-delivery gap
// runs to ~2.9h.

import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../src/stores/appStore';
import type { ContractEntry } from '../src/types';

const ADDRESS = 'So11111111111111111111111111111111111111112';
const MESSAGE_ID = 'tg_-1002345678_9911';
const CALL_AT = '2026-09-05T10:00:00.000Z';

function entry(over: Partial<ContractEntry> = {}): ContractEntry {
  return {
    address: ADDRESS,
    chain: 'sol',
    authorId: 'a1',
    authorName: 'caller',
    channelId: 'c1',
    channelName: 'calls',
    guildId: null,
    guildName: null,
    roomIds: ['r1'],
    messageId: MESSAGE_ID,
    timestamp: CALL_AT,
    source: 'telegram',
    ...over,
  };
}

describe('contracts slice — duplicate re-deliveries', () => {
  beforeEach(() => {
    useAppStore.setState({ contracts: [], addressChains: {} });
  });

  it('adds a normal (unflagged) scan', () => {
    useAppStore.getState().addContract(entry(), { skipCatalogHydrate: true });
    expect(useAppStore.getState().contracts).toHaveLength(1);
  });

  it('drops a flagged re-delivery of a call already showing', () => {
    const add = useAppStore.getState().addContract;
    add(entry(), { skipCatalogHydrate: true });
    add(entry({ duplicate: true }), { skipCatalogHydrate: true });
    expect(useAppStore.getState().contracts).toHaveLength(1);
    expect(useAppStore.getState().contracts[0].duplicate).toBeUndefined();
  });

  it('drops a flagged re-delivery even when the original has aged out of the store', () => {
    // The case the messageId guard cannot catch: the original row is gone (cap
    // eviction, or the console connected after the call), so without the flag
    // this would resurrect an hours-old call at the top of a live feed.
    useAppStore.getState().addContract(entry({ duplicate: true }), { skipCatalogHydrate: true });
    expect(useAppStore.getState().contracts).toHaveLength(0);
  });

  it('still admits a genuine repeat mention of the same address', () => {
    // A different message = a real second call, and it must keep reaching the
    // feed so the rescan grouping can collapse it into a "×2 scans" row.
    const add = useAppStore.getState().addContract;
    add(entry(), { skipCatalogHydrate: true });
    add(entry({ messageId: 'tg_-1002345678_9912', timestamp: '2026-09-05T10:04:00.000Z' }), {
      skipCatalogHydrate: true,
    });
    expect(useAppStore.getState().contracts).toHaveLength(2);
  });

  it('leaves the chain map untouched when it drops a frame', () => {
    const evm = '0xabc0000000000000000000000000000000000001';
    useAppStore.getState().addContract(
      entry({ address: evm, chain: 'evm', evmChain: 'base', duplicate: true }),
      { skipCatalogHydrate: true },
    );
    expect(useAppStore.getState().addressChains[evm]).toBeUndefined();
  });
});
