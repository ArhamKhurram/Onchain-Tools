import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundle the already-compiled backend (backend/dist) into a single ESM file so
// the packaged app doesn't need to ship node_modules. Requires `tsc` to have
// produced backend/dist first (see root `build:backend`).
const entry = path.join(__dirname, '..', 'backend', 'dist', 'index.js');
if (!existsSync(entry)) {
  console.error(
    `Backend build not found at ${entry}.\n` +
      'Run `npm run build:backend` from the repo root first.',
  );
  process.exit(1);
}

// The in-process FOMO client (backend/src/fomo/client.ts) drives a stealth
// Playwright Chromium. That path can never work in the packaged desktop app:
// no Playwright browsers are installed, and the stealth plugin's merge-deep
// dependency does a runtime require('kind-of') that esbuild cannot see — so a
// packaged backend crashed at BOOT (fomo/client.ts calls
// `chromium.use(stealth())` at module load). Stub the whole in-process
// Playwright stack; FomoClient.launch throws a clear error instead, and the
// proxy-mode client (FOMO_PROXY_URL) is unaffected.
const playwrightStubPlugin = {
  name: 'desktop-playwright-stub',
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /^(playwright|playwright-extra|puppeteer-extra-plugin-stealth)$/ },
      (args) => ({ path: args.path, namespace: 'playwright-stub' }),
    );
    pluginBuild.onLoad({ filter: /.*/, namespace: 'playwright-stub' }, (args) => {
      if (args.path === 'puppeteer-extra-plugin-stealth') {
        return { contents: 'module.exports = () => ({ name: "stealth-stub" });', loader: 'js' };
      }
      return {
        contents: `
          const unavailable = () => {
            throw new Error(
              'In-process Playwright is not available in the desktop build. ' +
                'Set FOMO_PROXY_URL + FOMO_WORKER_SECRET to use the remote FOMO worker.',
            );
          };
          const chromium = { use: () => {}, launch: unavailable, connect: unavailable };
          module.exports = { chromium, firefox: chromium, webkit: chromium };
        `,
        loader: 'js',
      };
    });
  },
};

await build({
  plugins: [playwrightStubPlugin],
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: path.join(__dirname, 'dist-backend', 'index.mjs'),
  // Provide a require() shim so CJS deps that call require() at runtime work
  // inside the ESM bundle.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  // fsevents is an optional macOS-only native dep pulled in transitively by
  // some tooling; it is not needed by the running server.
  external: ['fsevents'],
  logLevel: 'info',
});

console.log('Backend bundled to dist-backend/index.mjs');
