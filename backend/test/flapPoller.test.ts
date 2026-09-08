// The Flap watcher's detection loop, driven by a fake RPC + in-memory store +
// capturing delivery. The claims under test are the ones the whole feature
// turns on:
//   • DEDUPE IS ON THE ASSET, NOT THE VAULT — a second vault (a second meme)
//     against a stock already seen does NOT alert, even within one batch;
//   • SEEDING marks existing assets WITHOUT alerting, so day one is quiet;
//   • a non-allowlisted factory is ignored;
//   • the alert carries the FIRST token minted with the pairing.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FLAP_TOPIC0,
  RWA_ASSET_SELECTOR,
  SUPPORTED_ASSETS_SELECTOR,
  SYMBOL_SELECTOR,
  BSC_VAULTPORTAL,
  addressTopic,
  type RawLog,
} from '../src/flap/detect';
import { FlapChainWatcher, type FlapDelivery, type FlapStockAlertData } from '../src/flap/poller';
import type { FlapChainState, FlapStateStore } from '../src/flap/state';
import type { FlapRpc, GetLogsParams } from '../src/flap/rpc';

const V1 = '0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a'; // single resolver
const V3 = '0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5'; // array resolver
const STRANGER = '0x0000000000000000000000000000000000009999';
const PORTAL = BSC_VAULTPORTAL.toLowerCase();

const AAA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BBB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// Vault + token addresses must be full 40-hex: the watcher resolves a vault by
// the address it decodes from the log topic, so the fake's maps key on that.
const VAULT1 = '0x1000000000000000000000000000000000000001';
const VAULT2 = '0x1000000000000000000000000000000000000002';
const VAULTV3 = '0x1000000000000000000000000000000000000003';
const TOK_A = '0x2000000000000000000000000000000000000001';
const TOK_B = '0x2000000000000000000000000000000000000002';
const TOK_FIRST = '0x2000000000000000000000000000000000000010';
const TOK_SECOND = '0x2000000000000000000000000000000000000011';

const word = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const encAddress = (a: string): string => `0x${word(a)}`;
const encAddressArray = (arr: string[]): string =>
  `0x${(32).toString(16).padStart(64, '0')}${arr.length.toString(16).padStart(64, '0')}${arr
    .map(word)
    .join('')}`;
const encString = (s: string): string => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  const off = (32).toString(16).padStart(64, '0');
  const len = Buffer.byteLength(s, 'utf8').toString(16).padStart(64, '0');
  const body = hex === '' ? '0'.repeat(64) : hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return `0x${off}${len}${body}`;
};

interface FakeEvent {
  block: number;
  token: string;
  vault: string;
  factory: string;
}

class FakeRpc implements FlapRpc {
  callLog: string[] = [];
  constructor(
    public latest: number,
    public events: FakeEvent[],
    public vaultAssets: Record<string, string[]>,
    public symbols: Record<string, string>,
  ) {}

  async blockNumber(): Promise<number | null> {
    return this.latest;
  }

  async getLogs(params: GetLogsParams): Promise<RawLog[] | null> {
    return this.events
      .filter((e) => e.block >= params.fromBlock && e.block <= params.toBlock)
      .map((e) => ({
        address: PORTAL,
        topics: [FLAP_TOPIC0, addressTopic(e.token), addressTopic(e.vault), addressTopic(e.factory)],
        data: '0x',
        blockNumber: `0x${e.block.toString(16)}`,
      }));
  }

  async call(to: string, data: string): Promise<string | null> {
    this.callLog.push(`${to.toLowerCase()}:${data}`);
    const key = to.toLowerCase();
    if (data === RWA_ASSET_SELECTOR) {
      const a = this.vaultAssets[key]?.[0];
      return a ? encAddress(a) : null;
    }
    if (data === SUPPORTED_ASSETS_SELECTOR) {
      const arr = this.vaultAssets[key];
      return arr ? encAddressArray(arr) : null;
    }
    if (data === SYMBOL_SELECTOR) {
      const s = this.symbols[key];
      return s !== undefined ? encString(s) : null;
    }
    return null;
  }
}

class FakeStore implements FlapStateStore {
  state = new Map<string, FlapChainState>();
  async load(chain: string): Promise<FlapChainState> {
    return this.state.get(chain) ?? { lastScannedBlock: 0, seeded: false, knownAssets: [] };
  }
  async save(chain: string, s: FlapChainState): Promise<void> {
    this.state.set(chain, { ...s, knownAssets: [...s.knownAssets] });
  }
}

function makeWatcher(rpc: FakeRpc, store: FakeStore, delivered: FlapStockAlertData[]): FlapChainWatcher {
  const delivery: FlapDelivery = {
    hasSubscribers: async () => true,
    deliver: (d) => delivered.push(d),
  };
  return new FlapChainWatcher('bsc', rpc, store, delivery, {
    vaultPortal: PORTAL,
    seedBlocks: 1_000,
    maxSpan: 100_000,
    testLookbackBlocks: 500,
  });
}

describe('FlapChainWatcher — seeding', () => {
  it('marks every existing asset WITHOUT alerting, then marks seeded', async () => {
    const rpc = new FakeRpc(
      100,
      [{ block: 50, token: TOK_A, vault: VAULT1, factory: V1 }],
      { [VAULT1]: [AAA] },
      { [AAA]: 'FXIon' },
    );
    const store = new FakeStore();
    const delivered: FlapStockAlertData[] = [];

    await makeWatcher(rpc, store, delivered).poll();

    expect(delivered).toHaveLength(0); // day one is quiet
    const saved = store.state.get('bsc')!;
    expect(saved.seeded).toBe(true);
    expect(saved.knownAssets).toContain(AAA);
    expect(saved.lastScannedBlock).toBe(100);
  });
});

describe('FlapChainWatcher — detection deduped on the ASSET', () => {
  beforeEach(() => {});

  it('alerts the first time an asset is seen, carrying the first token', async () => {
    const rpc = new FakeRpc(
      115,
      [{ block: 110, token: TOK_A, vault: VAULT1, factory: V1 }],
      { [VAULT1]: [AAA] },
      { [AAA]: 'FXIon' },
    );
    const store = new FakeStore();
    store.state.set('bsc', { lastScannedBlock: 100, seeded: true, knownAssets: [] });
    const delivered: FlapStockAlertData[] = [];

    await makeWatcher(rpc, store, delivered).poll();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      network: 'bsc',
      symbols: ['FXIon'],
      firstTokenAddress: TOK_A,
    });
    expect(store.state.get('bsc')!.knownAssets).toContain(AAA);
  });

  it('does NOT alert for a second vault against the SAME asset (a new poll)', async () => {
    const store = new FakeStore();
    store.state.set('bsc', { lastScannedBlock: 100, seeded: true, knownAssets: [] });
    const delivered: FlapStockAlertData[] = [];

    // Poll 1: vault A introduces AAA → one alert.
    const rpc1 = new FakeRpc(
      115,
      [{ block: 110, token: TOK_A, vault: VAULT1, factory: V1 }],
      { [VAULT1]: [AAA] },
      { [AAA]: 'FXIon' },
    );
    await makeWatcher(rpc1, store, delivered).poll();

    // Poll 2: a DIFFERENT vault (a second meme) resolves to the SAME AAA.
    const rpc2 = new FakeRpc(
      125,
      [{ block: 120, token: TOK_B, vault: VAULT2, factory: V1 }],
      { [VAULT2]: [AAA] },
      { [AAA]: 'FXIon' },
    );
    await makeWatcher(rpc2, store, delivered).poll();

    expect(delivered).toHaveLength(1); // still just the first
  });

  it('collapses two same-asset vaults in ONE batch to a single alert (first token wins)', async () => {
    const rpc = new FakeRpc(
      130,
      [
        { block: 110, token: TOK_FIRST, vault: VAULT1, factory: V1 },
        { block: 111, token: TOK_SECOND, vault: VAULT2, factory: V1 },
      ],
      { [VAULT1]: [AAA], [VAULT2]: [AAA] },
      { [AAA]: 'FXIon' },
    );
    const store = new FakeStore();
    store.state.set('bsc', { lastScannedBlock: 100, seeded: true, knownAssets: [] });
    const delivered: FlapStockAlertData[] = [];

    await makeWatcher(rpc, store, delivered).poll();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].firstTokenAddress).toBe(TOK_FIRST);
  });

  it('ignores a vault from a non-allowlisted factory', async () => {
    const rpc = new FakeRpc(
      115,
      [{ block: 110, token: TOK_A, vault: VAULT1, factory: STRANGER }],
      { [VAULT1]: [AAA] },
      { [AAA]: 'FXIon' },
    );
    const store = new FakeStore();
    store.state.set('bsc', { lastScannedBlock: 100, seeded: true, knownAssets: [] });
    const delivered: FlapStockAlertData[] = [];

    await makeWatcher(rpc, store, delivered).poll();

    expect(delivered).toHaveLength(0);
    // Never even resolved the vault — the factory was dropped before eth_call.
    expect(rpc.callLog).toHaveLength(0);
  });

  it('v3 basket alerts only the NEW asset when one of two is already known', async () => {
    const rpc = new FakeRpc(
      115,
      [{ block: 110, token: TOK_A, vault: VAULTV3, factory: V3 }],
      { [VAULTV3]: [AAA, BBB] },
      { [AAA]: 'FXIon', [BBB]: 'NVDAB' },
    );
    const store = new FakeStore();
    store.state.set('bsc', { lastScannedBlock: 100, seeded: true, knownAssets: [AAA] });
    const delivered: FlapStockAlertData[] = [];

    await makeWatcher(rpc, store, delivered).poll();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].symbols).toEqual(['NVDAB']); // AAA was known
  });

  it('holds the cursor and does not alert when a log page fails', async () => {
    const rpc = new FakeRpc(115, [], {}, {});
    rpc.getLogs = async () => null; // simulate an RPC failure
    const store = new FakeStore();
    store.state.set('bsc', { lastScannedBlock: 100, seeded: true, knownAssets: [] });
    const delivered: FlapStockAlertData[] = [];

    await makeWatcher(rpc, store, delivered).poll();

    expect(delivered).toHaveLength(0);
    expect(store.state.get('bsc')!.lastScannedBlock).toBe(100); // not advanced
  });
});
