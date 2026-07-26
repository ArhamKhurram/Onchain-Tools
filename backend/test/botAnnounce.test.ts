import { describe, it, expect } from 'vitest';
import { buildAnnouncementComponents, type AnnouncePayload } from '../src/bot/commands/announce';
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

  it('labels a bot-kind announcement distinctly from a site one', () => {
    const site = JSON.stringify(buildAnnouncementComponents(payload({ kind: 'site' })));
    const bot = JSON.stringify(buildAnnouncementComponents(payload({ kind: 'bot' })));
    expect(site).toContain('Site update');
    expect(bot).toContain('Bot update');
    expect(bot).not.toContain('Site update');
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
