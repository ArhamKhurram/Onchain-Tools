/// <reference types="vite/client" />

// Build-time parsed CHANGELOG.md entries — see the changelog-updates plugin in vite.config.ts.
declare module 'virtual:oct-updates' {
  export const UPDATES: import('./data/parseChangelog').UpdateEntry[];
}
