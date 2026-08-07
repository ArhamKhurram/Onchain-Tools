# Embed assets for `scripts/post-embed.mjs`

Drop the two brand images here before running the embed script:

| File | What | Recommended size |
| --- | --- | --- |
| `banner.png` | The wide OCT banner (the "ONCHAIN TOOLS" header art) | ~1500×500 |
| `logo.png` | The square red OCT logo (top-right thumbnail) | ~1000×1000 (square) |

The script uploads both as message attachments and the embed references them via
`attachment://banner.png` / `attachment://logo.png` — nothing needs to be hosted.

To use different filenames or locations, set `OCT_EMBED_BANNER` / `OCT_EMBED_LOGO`.
