import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Round-trip + column budget for the token-catalog read path.
 *
 * getTokenSnapshot is the hot token lookup (every fomo trade, radar metadata
 * fetch, and bot token command funnels through it in hosted mode). This pins
 * three properties that were regressions waiting to happen:
 *
 *  - getCatalogEntry never selects '*': the `raw` jsonb (full provider payload,
 *    ~73% of the row's bytes) and `confidence` are write-only audit columns.
 *  - A cache MISS costs exactly one catalog read + one upsert — not a second
 *    read-back of the row that was just written.
 *  - The service client is constructed once, not per lookup.
 */

const queryLog: Array<{ table: string; op: 'select' | 'upsert'; columns?: string }> = [];
let selectRows: unknown[] = [];
let createClientCalls = 0;

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    createClientCalls += 1;
    class Query {
      constructor(private table: string, private columns: string) {
        queryLog.push({ table, op: 'select', columns });
      }
      ilike() { return this; }
      eq() { return this; }
      order() { return this; }
      limit() { return this; }
      maybeSingle(): Promise<{ data: unknown; error: null }> {
        return Promise.resolve({ data: selectRows[0] ?? null, error: null });
      }
    }
    return {
      from: (table: string) => ({
        select: (columns: string) => new Query(table, columns),
        upsert: (_row: unknown) => {
          queryLog.push({ table, op: 'upsert' });
          return Promise.resolve({ error: null });
        },
      }),
    };
  },
}));

// The cache-miss path falls through to live enrichment — stub the providers
// and the peak store so no network or second Supabase client is touched.
vi.mock('../src/utils/tokenEnrichment.js', () => ({
  enrichFromDexScreener: async () => ({
    address: 'So1MemeTokenAddressXXXXXXXXXXXXXXXXXXXXXXXX',
    tokenSymbol: 'EXMPL',
    tokenName: 'Example Meme Token',
    tokenPair: 'EXMPL/SOL',
    fdvAtCall: 1_200_000,
    fdvAtCallDisplay: '1.2M',
    liquidityUsd: 98_765,
    priceUsd: 0.0012,
    enrichmentSource: 'dexscreener',
  }),
}));
vi.mock('../src/utils/gmgnEnrichment.js', () => ({
  enrichFromGmgn: async () => null,
  resolveGmgnChain: () => null,
}));
vi.mock('../src/alerts/tokenPeakStore.js', () => ({
  recordPeakObservation: () => {},
}));

process.env.OCT_MODE = 'hosted';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
delete process.env.GMGN_API_KEY;

const { getTokenSnapshot } = await import('../src/utils/tokenSnapshot.js');

const ADDRESS = 'So1MemeTokenAddressXXXXXXXXXXXXXXXXXXXXXXXX';

function freshRow() {
  return {
    address: ADDRESS,
    chain: 'sol',
    evm_chain: null,
    symbol: 'EXMPL',
    name: 'Example Meme Token',
    pair: 'EXMPL/SOL',
    fdv: 1_200_000,
    liq: 98_765,
    price_usd: 0.0012,
    enriched_at: new Date().toISOString(),
    source: 'gmgn',
  };
}

beforeEach(() => {
  queryLog.length = 0;
  selectRows = [];
});

describe('token catalog read path budget', () => {
  it('cache hit: one column-scoped read, zero writes', async () => {
    selectRows = [freshRow()];
    const snapshot = await getTokenSnapshot('sol', ADDRESS);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.symbol).toBe('EXMPL');
    expect(snapshot?.mc).toBe(1_200_000);
    expect(snapshot?.stale).toBe(false);

    const selects = queryLog.filter((q) => q.op === 'select');
    expect(selects).toHaveLength(1);
    expect(queryLog.filter((q) => q.op === 'upsert')).toHaveLength(0);
  });

  it('never selects "*" — the raw/confidence audit columns stay off the wire', async () => {
    selectRows = [freshRow()];
    await getTokenSnapshot('sol', ADDRESS);

    for (const q of queryLog.filter((entry) => entry.op === 'select')) {
      expect(q.columns).toBeDefined();
      expect(q.columns).not.toContain('*');
      expect(q.columns).not.toContain('raw');
      expect(q.columns).not.toContain('confidence');
    }
  });

  it('cache miss: exactly one read and one upsert — no read-back of the row just written', async () => {
    selectRows = []; // no catalog row -> live enrichment path
    const snapshot = await getTokenSnapshot('sol', ADDRESS);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.symbol).toBe('EXMPL');
    expect(snapshot?.mc).toBe(1_200_000);
    expect(snapshot?.stale).toBe(false);

    expect(queryLog.filter((q) => q.op === 'select')).toHaveLength(1);
    expect(queryLog.filter((q) => q.op === 'upsert')).toHaveLength(1);
  });

  it('constructs the service client once across repeated lookups', async () => {
    selectRows = [freshRow()];
    const before = createClientCalls;
    await getTokenSnapshot('sol', ADDRESS);
    await getTokenSnapshot('sol', ADDRESS);
    await getTokenSnapshot('sol', ADDRESS);
    expect(createClientCalls - before).toBeLessThanOrEqual(1);
  });
});
