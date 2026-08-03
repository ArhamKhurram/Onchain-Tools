// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// User-facing guide for Onchain Tools. Deployed to Vercel at
// https://docs.onchaintools.tech (its own subdomain — separate from the
// developer docs, which live on GitHub Pages). Served from the domain root,
// so there is no `base` prefix.
export default defineConfig({
  site: 'https://docs.onchaintools.tech',
  integrations: [
    starlight({
      title: 'Onchain Tools',
      tagline: 'The user guide',
      description:
        'How to use Onchain Tools (OCT): connect Discord and Telegram, read the Feed, work the Radar, track FOMO traders, and tune every alert.',
      social: [
        { icon: 'x.com', label: 'X', href: 'https://x.com/toolsonchain' },
      ],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Getting Started', autogenerate: { directory: 'getting-started' } },
        { label: 'Connecting Accounts', autogenerate: { directory: 'connecting' } },
        { label: 'Rooms & Feed', autogenerate: { directory: 'feed' } },
        { label: 'Callers', autogenerate: { directory: 'callers' } },
        { label: 'FOMO', autogenerate: { directory: 'fomo' } },
        { label: 'Portfolio & Wallets', autogenerate: { directory: 'portfolio' } },
        { label: 'Alerts', autogenerate: { directory: 'alerts' } },
        { label: 'Settings Reference', autogenerate: { directory: 'settings' } },
      ],
    }),
  ],
});
