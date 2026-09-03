import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react';
          if (id.includes('react-router')) return 'vendor-router';
          if (id.includes('@supabase')) return 'vendor-supabase';
          // @tanstack/react-virtual + virtual-core (~17 kB min) have one consumer:
          // VirtualMessageList, which lands in the ChatPane chunk. ChatPane is one
          // of the most-edited files in the repo, so leaving the virtualizer inline
          // re-ships those stable vendor bytes to every returning user on every
          // feed/chat deploy. A dedicated chunk keeps its hash stable across app
          // deploys; it still only loads with ChatPane (no new boot-path request).
          if (id.includes('@tanstack')) return 'vendor-virtual';
          // motion (+ its framer-motion / motion-dom / motion-utils internals).
          // Same reasoning as vendor-virtual, and the same non-cost: nothing on
          // the boot path imports lib/motion.ts, so this chunk is only fetched
          // alongside the lazy route that animates — it adds no request to the
          // initial load. Splitting it out also keeps the animation runtime's
          // hash stable while the surfaces that use it are still being designed,
          // and makes its weight visible in the build output instead of hiding
          // it inside a page chunk. If it ever stops being lazy-only, that shows
          // up here as a boot-path request rather than as a silently fatter
          // index.
          if (
            id.includes('/motion/') ||
            id.includes('/framer-motion/') ||
            id.includes('/motion-dom/') ||
            id.includes('/motion-utils/')
          ) {
            return 'vendor-motion';
          }
          // lucide-react: no manual vendor chunk — let each icon module land in
          // the chunk(s) that use it, so boot only loads the chrome's icons.
          // No vendor-charts chunk anymore: recharts was replaced by the
          // hand-rolled SVG PnlLineChart (zero chart vendor code).
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3001',
      // The sniper control plane deliberately does NOT sit under /api, so it
      // needs its own entry — without one, a dev console with VITE_API_URL unset
      // requests /sniper/v1/* from the vite server itself and gets index.html.
      '/sniper/v1': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
