# Tasks

Operational to-do list for Onchain Tools. Things that need a human — dashboard
actions, decisions, and follow-ups that no PR can close on its own.

Keep it short. An item that has sat here for two sprints is either not real or
needs breaking down.

## This sprint

- [ ] **Submit both sitemaps to Google Search Console.** `robots.txt` and the
      sitemaps ship as of #192, but files existing does not get them crawled —
      the properties still have to be verified and the sitemaps submitted by
      hand. Two properties: `https://www.onchaintools.tech/sitemap.xml` (1 URL)
      and `https://docs.onchaintools.tech/sitemap-index.xml` (26 URLs). **The
      docs one is the one that matters** — it is the only substantial body of
      indexable content OCT has.

## Waiting on a decision

- [ ] **Reach existing desktop installs.** #177 repointed the auto-update feed
      and #191 removed the updater entirely, but neither reaches clients already
      installed: `publish` is baked into `app-update.yml` inside each packaged
      build, so a 1.1.1 install keeps its old feed forever and we have no write
      access to that repo. The only channel is out-of-band — a Discord post or
      landing banner telling anyone who installed before 2026-08-26 to
      uninstall. **Blocked on: how many Windows installs actually exist.**
      Nobody has established the number, and it decides whether this is a
      footnote or a headline.

- [ ] **Decide whether the `desktop/` workspace stays.** It builds and runs but
      is promoted nowhere, has no update path, and nobody installs it. Removing
      it is a bigger call than removing the installer was.

## Known, deliberately not doing

- **Referral codes stay.** Live since 2026-07-25 in
  `packages/shared/src/contract.ts`, including
  `injectReferralIntoCustomTemplate`, which rewrites a user's own configured
  link. Reviewed 2026-08-26 and kept as-is. Recorded here so it is a decision on
  file rather than something rediscovered and "fixed" later.

- **`CHANGELOG.md` keeps its history.** Entries before the rename still say
  "Trenchcord", and stale capability claims in dated entries are left alone —
  the file states this policy in its own header. Corrections go in the landing
  view (`landing/src/components/Changelog.tsx`), which is a curated marketing
  surface, not the record.
