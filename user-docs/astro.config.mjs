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
      components: {
        // Brand mark (OCT badge + Fraunces wordmark) in place of the plain title.
        SiteTitle: './src/components/SiteTitle.astro',
      },
      head: [
        // Brand fonts — Fraunces (heavy serif wordmark/headings) + IBM Plex Mono
        // (body), the same pair onchaintools.tech uses.
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,900&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
          },
        },
        // Default to the dark (black) brand theme unless the visitor already
        // chose one. Writes Starlight's own storage key so its theme script
        // resolves dark regardless of script order; the toggle still overrides.
        {
          tag: 'script',
          content:
            "try{if(!localStorage.getItem('starlight-theme')){localStorage.setItem('starlight-theme','dark');document.documentElement.dataset.theme='dark';}}catch(e){}",
        },
      ],
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
