import { defineConfig } from 'vitest/config';

// Frontend unit tests. A standalone Vitest config (not vite.config.ts) so pure
// util tests run without loading the React plugin. Tests live in `test/`, outside
// `src/`, so the app typecheck/build never picks them up.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
