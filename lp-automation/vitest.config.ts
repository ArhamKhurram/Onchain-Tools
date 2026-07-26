import { defineConfig } from 'vitest/config';

// LP-automation unit tests. Same convention as `backend/`: tests live in `test/`
// (outside `src/`) so the production `tsc` build never picks them up.
//
// Everything under test here must be PURE — the rule evaluator, policy
// validation, and the Krystal response mappers. No network, no RPC, no signer.
// The parts that touch a chain are verified by Foundry (contracts/) and by
// dry-run simulation at runtime, not by these tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
