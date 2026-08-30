import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseChangelog } from './src/data/parseChangelog';

const CHANGELOG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');

/**
 * Serves `virtual:oct-updates`: CHANGELOG.md parsed at build time into just
 * the newest entries the WHAT'S NEW section renders. The previous `?raw`
 * import inlined the ENTIRE changelog (32.7 kB, growing every release) into
 * the bundle and parsed it at runtime.
 */
function changelogUpdates(): Plugin {
  const VIRTUAL_ID = 'virtual:oct-updates';
  const RESOLVED_ID = '\0' + VIRTUAL_ID;
  return {
    name: 'oct-changelog-updates',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },
    load(id) {
      if (id !== RESOLVED_ID) return;
      this.addWatchFile(CHANGELOG_PATH);
      const raw = readFileSync(CHANGELOG_PATH, 'utf-8');
      return `export const UPDATES = ${JSON.stringify(parseChangelog(raw))};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), changelogUpdates()],
  server: {
    port: 5174,
    strictPort: true,
    // Keep the dev server able to read one level up (monorepo root); the updates
    // feed itself no longer serves CHANGELOG.md through the dev server — the
    // changelogUpdates plugin reads it directly at config/build time.
    fs: { allow: ['..', '../..'] },
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
