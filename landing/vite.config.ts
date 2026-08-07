import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/dashboard': {
        target: 'http://localhost:5173',
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // Deliberately WITHOUT changeOrigin, unlike /api above. The sniper control
      // plane proves same-origin by comparing the request's Origin against its
      // own Host (api/sniper/auth.ts), and changeOrigin would rewrite Host to
      // localhost:3001 while the browser still sends Origin: localhost:5174 —
      // turning a same-origin request into one that has to be allow-listed.
      // Preserving Host keeps `npm run dev` on the same-origin path.
      '/sniper/v1': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
