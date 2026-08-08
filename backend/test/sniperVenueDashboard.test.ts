import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SlotsharkDashboard,
  VendorAuthError,
  VendorContractError,
  VendorRequestError,
} from '../src/sniper/venue/slotsharkDashboard';

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
  it('calls the main host, not the regional trading host', async () => {
    // The trading API is {us,eu}.slotshark.xyz/buy. The dashboard API is the
    // main site. Sending dashboard calls to a regional box is the mistake this
    // guards, and it fails as a 404 that looks like a missing feature.
    const spy = mockFetch(200, '[]');
    await new SlotsharkDashboard({ apiToken: TOKEN }).listWallets();
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toBe('https://slotshark.xyz/api/dashboard/wallets');
    expect(url).not.toContain('us.slotshark.xyz');
    expect(url).not.toContain('eu.slotshark.xyz');
  });

  it('sends the bearer and no Content-Type on a GET', async () => {
    const spy = mockFetch(200, '[]');
    await new SlotsharkDashboard({ apiToken: TOKEN }).listWallets();
    const init = spy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});

describe('SlotsharkDashboard: wallet parsing', () => {
  const api = () => new SlotsharkDashboard({ apiToken: TOKEN });

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
  const api = () => new SlotsharkDashboard({ apiToken: TOKEN });

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
});
