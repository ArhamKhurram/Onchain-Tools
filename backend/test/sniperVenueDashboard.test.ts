import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SlotsharkDashboard,
  VendorAuthError,
  VendorContractError,
  VendorRequestError,
} from '../src/sniper/venue/slotsharkDashboard';
import { TwitterConfigValidationError } from '../src/sniper/venue/slotsharkTwitterConfig';

const TOKEN = 'test-venue-token-never-logged';

function mockFetch(status: number, body: string) {
  const spy = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SlotsharkDashboard: request shape', () => {
  it('calls the REGIONAL host the account is on, per the official docs', async () => {
    // /api/dashboard/* is documented on {us,eu}.slotshark.xyz, not on the bare
    // slotshark.xyz this used to call. The undocumented host answered, which is
    // exactly why the drift could sit unnoticed.
    const spy = mockFetch(200, '[]');
    await new SlotsharkDashboard({ apiToken: TOKEN, region: 'eu' }).listWallets();
    expect(spy.mock.calls[0]![0]).toBe('https://eu.slotshark.xyz/api/dashboard/wallets');
  });

  it('routes us and eu to different hosts', async () => {
    const spy = mockFetch(200, '[]');
    await new SlotsharkDashboard({ apiToken: TOKEN, region: 'us' }).listWallets();
    expect(spy.mock.calls[0]![0]).toBe('https://us.slotshark.xyz/api/dashboard/wallets');
  });

  it('sends the bearer and no Content-Type on a GET', async () => {
    const spy = mockFetch(200, '[]');
    await new SlotsharkDashboard({ apiToken: TOKEN, region: 'us' }).listWallets();
    const init = spy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});

describe('SlotsharkDashboard: wallet parsing', () => {
  const api = () => new SlotsharkDashboard({ apiToken: TOKEN, region: 'us' });

  it('parses their bare-array wallet response', async () => {
    mockFetch(200, JSON.stringify([{ pubkey: '62jb', label: 'Sniper Main', nonceCount: 6, enabled: true }]));
    expect(await api().listWallets()).toEqual([
      { pubkey: '62jb', label: 'Sniper Main', nonceCount: 6, enabled: true },
    ]);
  });

  it('also accepts a wrapped response', async () => {
    // Their config endpoints wrap ({configs:[...]}) while wallets do not. That
    // inconsistency is exactly what an undocumented API changes without notice.
    mockFetch(200, JSON.stringify({ wallets: [{ pubkey: '62jb', label: '', nonceCount: 0, enabled: false }] }));
    expect((await api().listWallets())[0]!.pubkey).toBe('62jb');
  });

  it('reports a MISSING nonceCount as unknown (-1), never as zero', async () => {
    // 0 would claim we know the wallet can run no concurrent fires, which would
    // fail every maxOpen check. Absent means we do not know the ceiling.
    mockFetch(200, JSON.stringify([{ pubkey: '62jb', label: 'x', enabled: true }]));
    expect((await api().listWallets())[0]!.nonceCount).toBe(-1);
  });

  it('drops one malformed row instead of blanking the list', async () => {
    mockFetch(200, JSON.stringify([{ nope: 1 }, { pubkey: 'good', label: '', nonceCount: 2, enabled: true }]));
    const wallets = await api().listWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0]!.pubkey).toBe('good');
  });

  it('treats a non-array body as a contract change, not an empty list', async () => {
    // Silently returning [] here would render "no wallets on the venue" for a
    // user who has several — a vendor change must be loud.
    mockFetch(200, JSON.stringify({ unexpected: true }));
    await expect(api().listWallets()).rejects.toBeInstanceOf(VendorContractError);
  });

  it('derives lamports when only balanceSol comes back', async () => {
    mockFetch(200, JSON.stringify({ balanceSol: 0.5 }));
    const b = await api().walletBalance('62jb');
    expect(b.balanceLamports).toBe(500_000_000);
  });
});

describe('SlotsharkDashboard: failure taxonomy', () => {
  const api = () => new SlotsharkDashboard({ apiToken: TOKEN, region: 'us' });

  it('distinguishes auth failure, because the operator fix differs', async () => {
    mockFetch(401, '{"error":"missing or invalid Bearer"}');
    await expect(api().listWallets()).rejects.toBeInstanceOf(VendorAuthError);
  });

  it('surfaces other statuses as request errors', async () => {
    mockFetch(429, 'slow down');
    await expect(api().listWallets()).rejects.toBeInstanceOf(VendorRequestError);
  });

  it('never puts the token in an error message', async () => {
    // This module holds a credential that also authorizes /buy and
    // /wallets/withdraw, so every throw path is checked, not just the happy one.
    for (const [status, body] of [
      [401, 'nope'],
      [500, 'boom'],
      [200, 'not json'],
    ] as const) {
      mockFetch(status, body);
      const err = await api()
        .listWallets()
        .catch((e: Error) => e);
      expect(String(err)).not.toContain(TOKEN);
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
    }
  });

  it('does not forward a caught network error verbatim', async () => {
    // A thrown fetch error can carry request context; the message is
    // constructed here rather than passed through.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED with Bearer ${TOKEN}`);
      }),
    );
    const err = await api()
      .listWallets()
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(VendorRequestError);
    expect(String(err)).not.toContain(TOKEN);
  });

  it('surfaces the untracked-handle refusal verbatim, handles and all', async () => {
    // "These handles are not available for tracking: ..." is the one vendor
    // error whose payload IS the fix — the handles it names are the ones the
    // operator has to remove. A summary or an early clip would strip exactly
    // the part that makes it actionable.
    const handles = Array.from({ length: 40 }, (_, i) => `unavailablehandle${i}`).join(', ');
    const message = `These handles are not available for tracking: ${handles}`;
    mockFetch(400, JSON.stringify({ error: message }));
    const err = await api()
      .listWallets()
      .catch((e: Error) => e);
    expect(String(err)).toContain('These handles are not available for tracking');
    expect(String(err)).toContain('unavailablehandle39');
  });
});

describe('SlotsharkDashboard: twitter config CRUD', () => {
  const api = () => new SlotsharkDashboard({ apiToken: TOKEN, region: 'us' });
  const CONFIG = { id: 'cfg_1', name: 'scanner', modeType: 'ca_scanner', maxBuyCount: 3 };

  const scanner = () =>
    ({
      mode: 'ca_scanner',
      name: 'scanner',
      params: {
        targetHandles: ['@Elon'],
        triggers: { mainTweet: true, retweet: false, quote: false, reply: false },
      },
      snipeParams: { solAmount: 0.25 },
    }) as const;

  it('hits the documented paths and verbs', async () => {
    const calls: [string, string][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push([String(init.method), url]);
        return new Response(JSON.stringify({ configs: [], config: CONFIG, deletedAt: '2026-08-08T00:00:00Z' }), {
          status: 200,
        });
      }),
    );
    const a = api();
    await a.listTwitterConfigs();
    await a.createTwitterConfig(scanner());
    await a.replaceTwitterConfig('cfg 1', scanner());
    await a.patchTwitterConfig('cfg 1', { mode: 'ca_scanner', name: 'renamed' });
    await a.deleteTwitterConfig('cfg 1');

    expect(calls).toEqual([
      ['GET', 'https://us.slotshark.xyz/api/dashboard/twitter/configs'],
      ['POST', 'https://us.slotshark.xyz/api/dashboard/twitter/configs'],
      // The id is percent-encoded: an id with a slash would otherwise reach a
      // different endpoint entirely.
      ['PUT', 'https://us.slotshark.xyz/api/dashboard/twitter/configs/cfg%201'],
      ['PATCH', 'https://us.slotshark.xyz/api/dashboard/twitter/configs/cfg%201'],
      ['DELETE', 'https://us.slotshark.xyz/api/dashboard/twitter/configs/cfg%201'],
    ]);
  });

  it('normalizes the body it sends, not just the one it validates', async () => {
    const spy = mockFetch(201, JSON.stringify({ config: CONFIG }));
    await api().createTwitterConfig(scanner());
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.modeType).toBe('ca_scanner');
    expect(body.params.targetHandles).toEqual(['elon']);
    expect(body.snipeParams.solAmount).toBe(0.25);
    // Fees and slippage live inside snipeParams; a top-level tip is a 400.
    expect(body.tip).toBeUndefined();
    expect(body.sellTip).toBeUndefined();
  });

  it('refuses locally instead of sending a body the vendor would 400', async () => {
    const spy = mockFetch(201, JSON.stringify({ config: CONFIG }));
    await expect(
      api().createTwitterConfig({ ...scanner(), snipeParams: {} as { solAmount: number } }),
    ).rejects.toBeInstanceOf(TwitterConfigValidationError);
    // The point of a local refusal is that no request happens at all.
    expect(spy).not.toHaveBeenCalled();
  });

  it('never sends modeType on a PATCH, because mode is immutable', async () => {
    const spy = mockFetch(200, JSON.stringify({ config: CONFIG }));
    await api().patchTwitterConfig('cfg_1', { mode: 'engagement', name: 'renamed' });
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body).toEqual({ name: 'renamed' });
    expect(body.modeType).toBeUndefined();
  });

  it('reports an unknown modeType as null rather than guessing one', async () => {
    // A mode this build does not know cannot be patched: the params serializer
    // is chosen by mode, so a guess would send the wrong keyword spelling.
    mockFetch(200, JSON.stringify({ configs: [{ id: 'c1', name: 'x', modeType: 'quote_tweet_v2' }] }));
    expect((await api().listTwitterConfigs())[0]!.modeType).toBeNull();
  });

  it('treats an absent maxBuyCount as unlimited (null), never as zero', async () => {
    // 0 would read as "no buys left" and would mean this config is spent.
    mockFetch(200, JSON.stringify({ configs: [{ id: 'c1', name: 'x', modeType: 'mention' }] }));
    expect((await api().listTwitterConfigs())[0]!.maxBuyCount).toBeNull();
  });

  it('treats a missing configs envelope as a contract change, not an empty account', async () => {
    // Showing "no configs" to an operator who has five invites them to create
    // duplicates of rules that are already live and spending.
    mockFetch(200, JSON.stringify([{ id: 'c1' }]));
    await expect(api().listTwitterConfigs()).rejects.toBeInstanceOf(VendorContractError);
  });

  it('treats a create response with no config as a contract change', async () => {
    mockFetch(201, JSON.stringify({ ok: true }));
    await expect(api().createTwitterConfig(scanner())).rejects.toBeInstanceOf(VendorContractError);
  });

  it('does not fail a delete just because deletedAt is missing', async () => {
    // The row is gone either way; claiming failure invites a second delete.
    mockFetch(200, JSON.stringify({}));
    expect(await api().deleteTwitterConfig('cfg_1')).toEqual({ deletedAt: null });
  });
});
