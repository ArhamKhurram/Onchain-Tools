import { describe, it, expect, vi } from 'vitest';
import { AnnounceError, buildAnnouncementComponents, postAnnouncement, type AnnouncePayload } from '../src/bot/announce';
import { SITE_ACCENT } from '../src/bot/layout';

const payload = (over: Partial<AnnouncePayload> = {}): AnnouncePayload => ({
  title: 'Notification History',
  description: 'Bell icon in the header keeps your last 10 alerts.',
  kind: 'site',
  imageUrl: null,
  linkUrl: null,
  ...over,
});

describe('buildAnnouncementComponents', () => {
  it('uses the site brand accent, not a generic Discord color', () => {
    const [container] = buildAnnouncementComponents(payload()) as any[];
    expect(container.accent_color).toBe(SITE_ACCENT);
  });

  it('renders the title, description, and a kind label', () => {
    const text = JSON.stringify(buildAnnouncementComponents(payload()));
    expect(text).toContain('Notification History');
    expect(text).toContain('Bell icon in the header');
    expect(text).toContain('Site update');
  });

  it('labels a bot-kind announcement distinctly from a site one, and defaults to site', () => {
    const site = JSON.stringify(buildAnnouncementComponents(payload({ kind: 'site' })));
    const bot = JSON.stringify(buildAnnouncementComponents(payload({ kind: 'bot' })));
    const defaulted = JSON.stringify(buildAnnouncementComponents(payload({ kind: undefined })));
    expect(site).toContain('Site update');
    expect(bot).toContain('Bot update');
    expect(bot).not.toContain('Site update');
    expect(defaulted).toContain('Site update');
  });

  it('omits the image gallery and link line when absent', () => {
    const text = JSON.stringify(buildAnnouncementComponents(payload()));
    expect(text).not.toContain('"type":12');
    expect(text).not.toContain('Open →');
  });

  it('includes an image gallery when an image url is given', () => {
    const text = JSON.stringify(
      buildAnnouncementComponents(payload({ imageUrl: 'https://onchain.tools/updates/x.png' })),
    );
    expect(text).toContain('"type":12');
    expect(text).toContain('https://onchain.tools/updates/x.png');
  });

  it('includes a link line when a link url is given', () => {
    const text = JSON.stringify(
      buildAnnouncementComponents(payload({ linkUrl: 'https://onchain.tools/dashboard' })),
    );
    expect(text).toContain('Open →');
    expect(text).toContain('https://onchain.tools/dashboard');
  });
});

describe('postAnnouncement', () => {
  const OLD_ENV = process.env.DISCORD_ANNOUNCE_CHANNEL_ID;

  it('throws bot_disabled when there is no client', async () => {
    await expect(postAnnouncement(null, payload())).rejects.toMatchObject({ code: 'bot_disabled' });
  });

  it('throws not_configured when the channel env var is unset', async () => {
    delete process.env.DISCORD_ANNOUNCE_CHANNEL_ID;
    const fakeClient: any = { channels: { fetch: vi.fn() } };
    await expect(postAnnouncement(fakeClient, payload())).rejects.toMatchObject({ code: 'not_configured' });
    expect(fakeClient.channels.fetch).not.toHaveBeenCalled();
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = OLD_ENV;
  });

  it('posts to the configured channel and returns its id', async () => {
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = 'chan-1';
    const send = vi.fn().mockResolvedValue(undefined);
    const fakeClient: any = { channels: { fetch: vi.fn().mockResolvedValue({ send }) } };

    const result = await postAnnouncement(fakeClient, payload());

    expect(result).toEqual({ channelId: 'chan-1' });
    expect(fakeClient.channels.fetch).toHaveBeenCalledWith('chan-1');
    expect(send).toHaveBeenCalledOnce();
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = OLD_ENV;
  });

  it('maps a Discord permission error on fetch to forbidden', async () => {
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = 'chan-1';
    const fakeClient: any = { channels: { fetch: vi.fn().mockRejectedValue({ code: 50001 }) } };
    await expect(postAnnouncement(fakeClient, payload())).rejects.toMatchObject({ code: 'forbidden' });
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = OLD_ENV;
  });

  it('maps a Discord permission error on send to forbidden', async () => {
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = 'chan-1';
    const send = vi.fn().mockRejectedValue({ code: 50013 });
    const fakeClient: any = { channels: { fetch: vi.fn().mockResolvedValue({ send }) } };
    await expect(postAnnouncement(fakeClient, payload())).rejects.toMatchObject({ code: 'forbidden' });
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = OLD_ENV;
  });

  it('throws channel_unavailable when the channel cannot send messages', async () => {
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = 'chan-1';
    const fakeClient: any = { channels: { fetch: vi.fn().mockResolvedValue({ isVoiceBased: () => true }) } };
    await expect(postAnnouncement(fakeClient, payload())).rejects.toMatchObject({ code: 'channel_unavailable' });
    process.env.DISCORD_ANNOUNCE_CHANNEL_ID = OLD_ENV;
  });

  it('AnnounceError carries its code as a property (not just in the message)', () => {
    const err = new AnnounceError('forbidden', 'nope');
    expect(err.code).toBe('forbidden');
    expect(err).toBeInstanceOf(Error);
  });
});
