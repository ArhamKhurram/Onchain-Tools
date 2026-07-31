# video

Remotion compositions for OCT's showcase and onboarding videos.

```bash
cd video
npm install
npm run dev              # Remotion Studio — scrub and preview
npm run render:showcase  # out/showcase.mp4
npm run render:guide     # out/guide.mp4
```

## Why this is not an npm workspace

Root `package.json` lists `packages/*`, `backend`, `frontend`, `landing`,
`fomo-worker`, `docs` — and deliberately not this. Remotion's renderer bundles a
headless browser, so adding it to the workspace set would slow `npm ci` on **every**
CI run, including backend-only PRs, and CI would typecheck it on each one. None of
that buys anything: this directory is never deployed.

`desktop/` already solved the same problem the same way (`npm --prefix desktop`), so
this follows an existing precedent rather than inventing one.

Consequence: run `npm install` inside `video/` separately. Root scripts do not
reach it.

## Compositions

| id | length | purpose |
| --- | --- | --- |
| `Showcase` | ~30 s | the cut that goes under a tweet |
| `Guide` | ~100 s | onboarding walkthrough, pinned / linked from the landing page |

`Guide` mirrors `landing/src/components/Tutorial.tsx` step for step — Requirements →
Sign in → Discord token → Rooms → Telegram → Running. **That component is the source
of truth.** If the onboarding flow changes there, update it here; never the reverse,
or the video will teach a flow the product no longer has.

## Brand

`src/brand.ts` mirrors `landing/tailwind.config.js`: black, flame red `#ff1744`,
Fraunces display, IBM Plex Mono. Keep them in sync by hand — they are separate build
systems and nothing enforces it.

`src/fonts.ts` loads the real webfonts. Without it the renderer silently falls back
to a system serif and the video still renders, just off-brand — a bug you only catch
by looking at a frame, so do not remove the import from `brand.ts`.

## Screen footage

Compositions reference clips under `public/capture/` (gitignored — large binaries,
regenerated rather than committed). Until a clip exists, `ScreenSlot` / `ScreenStep`
render a labelled placeholder so timing can be locked before capture.

`ScreenStep` takes a `focus` in 0..1 frame units, which is what drives the zoom-ins,
and survives a resolution change.

### Security

The guide's step 3 shows the Discord token field. **Capture it with a throwaway
token.** `ScreenStep`'s `redact` prop draws a hard block over a region for anything
that must not ship — but redaction in post is the fallback, not the plan. A real
token visible for one frame is a leaked credential, and video frames are trivially
extractable.
