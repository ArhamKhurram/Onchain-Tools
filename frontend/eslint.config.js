// ESLint flat config for the console workspace.
//
// This exists for ONE reason: `react-hooks/rules-of-hooks`. A `useMemo` placed
// after an early `return` in a console page (commit f382999) passed
// `tsc --noEmit`, passed `vite build`, and passed a signed-out smoke test —
// then blanked the whole page
// (with an empty browser console) the moment auth resolved and the hook count
// changed. Only a linter catches that class of bug, so `rules-of-hooks` is an
// error and CI fails on it. Do not downgrade it.
//
// `exhaustive-deps` is a warning on purpose: it is advisory, frequently wants
// deps that are wrong to add, and should never be what blocks a merge.
//
// Scope is deliberately narrow — the two hook rules and nothing else:
//
//   * No `js.configs.recommended` / `tseslint.configs.recommended`. Turning
//     those on flags 5 pre-existing cosmetic issues (an unnecessary regex
//     escape, a `let` that could be `const`, a `case`-block declaration, and
//     two false positives on intentional \x00 sentinel regexes in
//     components/message/content.tsx). None are bugs, and a red lint run should
//     mean "you broke the rules of hooks", not "you have a stylistic nit".
//   * No eslint-plugin-react-hooks `recommended` preset either — in v7 that
//     also enables the React Compiler rules, a much larger and unrelated change.
//
// typescript-eslint is here purely as the PARSER so .ts/.tsx files can be read;
// none of its rules are enabled. Widening this config is a fine follow-up, but
// it is separate work from closing the rules-of-hooks gap.

import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default [
  {
    // dist/ is gitignored build output; neither it nor deps are source.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Vite/Tailwind/PostCSS/Vitest config files run in Node, not the browser.
    files: ['*.config.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
]
