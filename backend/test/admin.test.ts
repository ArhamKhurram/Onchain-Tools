import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// isAdminUser reaches for hosted-mode detection and the Discord identity link,
// both of which are environment-bound. Stub them so the gate's own logic is
// what's under test rather than Supabase availability.
const hoisted = vi.hoisted(() => ({ hosted: true, discordId: null as string | null }));

vi.mock('../src/storage/index.js', () => ({
  isHostedMode: () => hoisted.hosted,
}));

vi.mock('../src/bot/identity.js', () => ({
  resolveDiscordIdByOctUser: async () => hoisted.discordId,
}));

const { isAdminUser, adminGatingConfigured } = await import('../src/auth/admin.js');

const SUPA = '8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
const DISCORD = '931486067150975046';

describe('admin gating', () => {
  const original = process.env.OCT_ADMIN_IDS;

  beforeEach(() => {
    hoisted.hosted = true;
    hoisted.discordId = null;
    delete process.env.OCT_ADMIN_IDS;
    delete process.env.TRENCHCORD_ADMIN_IDS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OCT_ADMIN_IDS;
    else process.env.OCT_ADMIN_IDS = original;
  });

  it('fails closed when no allow-list is configured', async () => {
    expect(adminGatingConfigured()).toBe(false);
    await expect(isAdminUser(SUPA)).resolves.toBe(false);
  });

  it('admits a Supabase UUID listed directly', async () => {
    process.env.OCT_ADMIN_IDS = SUPA;
    await expect(isAdminUser(SUPA)).resolves.toBe(true);
    await expect(isAdminUser('someone-else')).resolves.toBe(false);
  });

  it('admits a Discord ID via the linked identity', async () => {
    process.env.OCT_ADMIN_IDS = DISCORD;
    hoisted.discordId = DISCORD; // this account has Discord linked
    await expect(isAdminUser(SUPA)).resolves.toBe(true);
  });

  it('rejects when the account links to a different Discord ID', async () => {
    process.env.OCT_ADMIN_IDS = DISCORD;
    hoisted.discordId = '111111111111111111';
    await expect(isAdminUser(SUPA)).resolves.toBe(false);
  });

  it('rejects when the account has no linked Discord identity', async () => {
    process.env.OCT_ADMIN_IDS = DISCORD;
    hoisted.discordId = null;
    await expect(isAdminUser(SUPA)).resolves.toBe(false);
  });

  it('parses a comma-separated list with whitespace and blanks', async () => {
    process.env.OCT_ADMIN_IDS = ` ${SUPA} , , ${DISCORD} `;
    expect(adminGatingConfigured()).toBe(true);
    await expect(isAdminUser(SUPA)).resolves.toBe(true);
  });

  it('rejects a missing userId', async () => {
    process.env.OCT_ADMIN_IDS = SUPA;
    await expect(isAdminUser(undefined)).resolves.toBe(false);
  });

  it('allows everyone in local mode, where there is no auth boundary', async () => {
    hoisted.hosted = false;
    await expect(isAdminUser(undefined)).resolves.toBe(true);
    await expect(isAdminUser('local')).resolves.toBe(true);
  });
});
