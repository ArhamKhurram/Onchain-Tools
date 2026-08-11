import { defineConfig } from 'vitest/config';

// Worker unit tests. Tests live in `test/` (outside `src/`) so the production
// `tsc` build never picks them up — same convention as the backend workspace.
// Pure functions only — no network, no browser.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
