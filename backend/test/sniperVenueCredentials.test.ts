import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getVenueSecret } from '../src/sniper/venueCredentials';

// Only the local-mode path is unit-testable here: it is pure env lookup. The
// hosted path calls a real Supabase RPC (sniper_get_venue_secret) and is
// integration-tested against the dev project, not mocked here — a mock would
// only prove the mock is correct, not that the RPC/RLS/Vault wiring is.
describe('getVenueSecret — local mode', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.OCT_MODE = 'local';
    delete process.env.TRENCHCORD_MODE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('reads SLOTSHARK_API_TOKEN for the slotshark venue', async () => {
    process.env.SLOTSHARK_API_TOKEN = 'shark-token';
    expect(await getVenueSecret('local', 'slotshark')).toBe('shark-token');
  });

  // GMGN is deliberately not a Phase 1 venue: GMGN_API_KEY is the OPERATOR's
  // enrichment credential, and wiring it as a trading credential would execute
  // every user's snipes on the operator's own GMGN account.
  it('never resolves a trading credential from the operator GMGN_API_KEY', async () => {
    process.env.GMGN_API_KEY = 'operator-enrichment-key';
    // @ts-expect-error 'gmgn_openapi' is intentionally not a Venue in Phase 1.
    expect(await getVenueSecret('local', 'gmgn_openapi')).toBeNull();
  });

  it('returns null rather than an empty string when unset', async () => {
    delete process.env.SLOTSHARK_API_TOKEN;
    expect(await getVenueSecret('local', 'slotshark')).toBeNull();
  });

  it('trims whitespace', async () => {
    process.env.SLOTSHARK_API_TOKEN = '  shark-token  \n';
    expect(await getVenueSecret('local', 'slotshark')).toBe('shark-token');
  });

  it('never resolves a secret for the dryrun venue', async () => {
    process.env.SLOTSHARK_API_TOKEN = 'shark-token';
    expect(await getVenueSecret('local', 'dryrun')).toBeNull();
  });
});
