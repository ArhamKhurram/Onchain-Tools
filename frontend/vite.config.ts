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
