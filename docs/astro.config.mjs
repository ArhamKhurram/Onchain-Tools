// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Deployed to GitHub Pages at https://arhamkhurram.github.io/Onchain-Tools/
// (base must match the repo name). `astro dev` serves under the same base.
export default defineConfig({
  site: 'https://arhamkhurram.github.io',
  base: '/Onchain-Tools',
  markdown: {
    // Leave ```mermaid fences as plain <pre><code class="language-mermaid">
    // so the client-side renderer (public/mermaid.js) can pick them up.
    syntaxHighlight: { type: 'shiki', excludeLangs: ['mermaid'] },
  },
  integrations: [
    starlight({
      title: 'Onchain Tools',
      description: 'Developer documentation for Onchain Tools (OCT) — real-time crypto intelligence console.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/ArhamKhurram/Onchain-Tools' },
      ],
      // Expressive Code would swallow ```mermaid fences before the client
      // renderer could see them; plain Shiki highlighting is enough here.
      expressiveCode: false,
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'script',
          attrs: { type: 'module', src: '/Onchain-Tools/mermaid.js' },
        },
      ],
      sidebar: [
        { label: 'Getting Started', autogenerate: { directory: 'getting-started' } },
        { label: 'Architecture', autogenerate: { directory: 'architecture' } },
        { label: 'Roadmap', autogenerate: { directory: 'roadmap' } },
        { label: 'Decisions (ADRs)', autogenerate: { directory: 'adr' }, collapsed: true },
        { label: 'API Reference', autogenerate: { directory: 'api' } },
        { label: 'Data Model', autogenerate: { directory: 'data' } },
        { label: 'Testing', autogenerate: { directory: 'testing' } },
        { label: 'Operations', autogenerate: { directory: 'operations' } },
        { label: 'Contributing', autogenerate: { directory: 'contributing' } },
      ],
    }),
  ],
});
