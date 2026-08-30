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
          if (id.includes('lucide-react')) return 'vendor-icons';
          // The recharts ecosystem (recharts + its d3/lodash/decimal.js-light deps) is
          // ~830 kB and used ONLY by the lazy PnlChartModal (verified: no direct app
          // imports of lodash/decimal.js-light). Grouping it into one stable vendor chunk
          // keeps it off the initial path (it still only loads on chart open, via the
          // lazy modal) AND makes it cacheable across app-code deploys — an app update no
          // longer invalidates 396 kB of chart vendor code in returning users' caches.
          if (
            id.includes('recharts') ||
            id.includes('/d3-') ||
            id.includes('react-smooth') ||
            id.includes('decimal.js-light') ||
            id.includes('/lodash/')
          )
            return 'vendor-charts';
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
