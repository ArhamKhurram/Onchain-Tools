import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { describeServiceError } from '../src/bot/errors';
import { BotServiceError } from '../src/bot/service';

// The identity resolver reaches Supabase, so exercise it through a mocked
// service client rather than a live DB.
const rpc = vi.fn();
vi.mock('../src/fomo/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fomo/store.js')>();
  return { ...actual, getFomoServiceClient: () => ({ rpc }) };
});

const { resolveOctUserByDiscordId, clearIdentityCache } = await import('../src/bot/identity.js');

const OCT_USER = '11111111-2222-3333-4444-555555555555';

describe('resolveOctUserByDiscordId', () => {
  beforeEach(() => {
    rpc.mockReset();
    clearIdentityCache();
  });
  afterEach(() => clearIdentityCache());

  it('returns the OCT user id for a linked Discord account', async () => {
    rpc.mockResolvedValue({ data: OCT_USER, error: null });
    await expect(resolveOctUserByDiscordId('123456789')).resolves.toBe(OCT_USER);
    expect(rpc).toHaveBeenCalledWith('oct_user_id_by_discord_id', { p_discord_id: '123456789' });
  });

  it('returns null when the Discord account is not linked', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(resolveOctUserByDiscordId('999')).resolves.toBeNull();
  });

  it('degrades to null (never throws) on a lookup error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(resolveOctUserByDiscordId('123')).resolves.toBeNull();

    rpc.mockRejectedValue(new Error('network down'));
    clearIdentityCache();
    await expect(resolveOctUserByDiscordId('123')).resolves.toBeNull();
  });

  it('ignores blank ids without hitting the database', async () => {
    await expect(resolveOctUserByDiscordId('   ')).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('memoises a positive result', async () => {
    rpc.mockResolvedValue({ data: OCT_USER, error: null });
    await resolveOctUserByDiscordId('abc');
    await resolveOctUserByDiscordId('abc');
    expect(rpc).toHaveBeenCalledOnce();
  });
});

describe('describeServiceError — gatekeeping', () => {
  it('tells unlinked Discord users how to link', () => {
    const msg = describeServiceError(new BotServiceError('not_linked', 'nope'), 'load traders');
    expect(msg).toContain("isn't linked");
    expect(msg.toLowerCase()).toContain('sign in to oct with discord');
  });

  it('maps the other service error codes to friendly copy', () => {
    expect(describeServiceError(new BotServiceError('not_configured', 'x'), 'a')).toContain('not configured');
    expect(describeServiceError(new BotServiceError('upstream', 'x'), 'a')).toContain('not responding');
    expect(describeServiceError(new BotServiceError('not_found', 'no holders'), 'a')).toContain('no holders');
  });

  it('never leaks internals for unknown errors', () => {
    const msg = describeServiceError(new Error('SECRET internal detail'), 'do the thing');
    expect(msg).not.toContain('SECRET');
    expect(msg).toContain('do the thing');
  });
});
