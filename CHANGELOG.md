# Changelog

All notable changes to Trenchcord are documented here.

## 2026-07-30

### Fixed
- **Contract scans show up immediately again** — a scan could take up to a minute or two to appear in the feed after its toast fired, because the row was held back until Rick (or a DexScreener/GMGN lookup) finished enriching it. Scans now appear the instant they're detected and fill in with token info moments later, matching the toast.
- **Missed-runner alerts fire again after their cooldown** — the first alert for a token was silently also the last: once its cooldown lapsed, the dedupe record could never be refreshed, so that token could never alert you again. The record now updates in place and the cooldown re-arms the way the setting says it should.
- **FOMO Live starts empty on every reload** — the feed was WebSocket-only, so it showed nothing but whatever arrived since you opened the page. The trades were being stored the whole time; nothing read them back. The console now replays your last 24 hours on load (`GET /api/fomo/trades`) and merges live frames on top, deduped by trade id.
- **Replayed trades show when they happened** — the live WS frame carries no timestamp, so the feed stamped arrival time. Rows now carry the stored event time, and a day of backfill no longer renders as if it all happened at page load.
- **Stale trades can no longer fake a convergence** — signal convergence compared a trade's *arrival* time against the contract call. With history replay that would have matched every day-old buy against whatever was called at reload, firing false convergence alerts on every refresh. It now compares when the trade actually happened.

### Added
- **FOMO trades now show what was actually bought, and can alert you** — trades only ever carried a bare address (and sometimes a ticker); they now show the token's name and market cap too. Each tracked trader also gets a toast and a dedicated sound (Settings → Sounds & Notifications → FOMO Trade) on their trades — the same toggle you already use for Pushover on that trader now covers this too, so there's nothing new to configure.
- **The Outpost bot is live** — the Discord bot now runs in production: slash commands (`/token`, `/holders`, `/leaderboard`, `/tracked`, `/wallet`) in the server and in DMs, plus opt-in DM alerts for your highlights, keywords, contract scans, and missed runners (Settings → Notifications → Discord DMs).
- **FOMO trade retention** — a sweeper prunes `fomo_trade_events` past a retention window (default 7 days, `FOMO_TRADE_RETENTION_DAYS`); deliveries cascade. The log is a firehose of every swap by every tracked trader, so it grew without bound. Retention is deliberately longer than the 24h the console asks for: deleting an event also drops the unique `trade_id` that stops it being dispatched twice.

## 2026-07-29

### Added
- **Caller quality — the slop filter** — rank contract calls by who sent them. Two layers:
  - **Manual tiers** — right-click any name in a chat feed to set `mute` / `normal` / `trust`. Tiers apply globally or per room, and a room tier beats the global one, so a caller can be slop in one room and fine in another. When several rooms match at once the most restrictive wins, so a mute is never silently overridden.
  - **Earned scores** — each caller is scored on their own calls: the market cap at the moment *they* posted, against the highest that token has reached since. Five people calling the same CA called it at five different market caps, and they're scored accordingly. Posting the same CA ten times counts once. Callers stay `unrated` below 10 scored calls rather than showing a number built on noise.
- **Where it shows** — the contract feed and Radar filter and rank by quality; the chat feed only colours the username, since reordering chat would break reply context. Radar gains a sortable `Caller` column. Settings → Caller Quality manages tiers and shows the scoreboard.
- **Token peak sampler** — a background pass records each token's high-water market cap, which is what scoring reads. Scoring against *current* market cap would mark down every caller whose token ran and then bled, which is nearly all of them. Runs in both hosted and local mode, so the desktop app scores callers too.

### Notes
- Muted callers are collapsed behind a counter, not deleted, and still count toward Radar mention totals — a caller you've written off can still be first on a runner, and you should be able to find that out.
- Caller quality is a display and filter layer only. It is deliberately **not** folded into the convergence score: two independent signals agreeing is only meaningful while they stay independent.
- New Supabase migration: `20260729120000_token_peaks.sql`.

### Fixed
- **MC@call on Telegram scans** — Telegram calls now record a market cap. The DexScreener/GMGN fallback stripped FDV from its patch because that field was reserved for Rick embeds, and Rick only exists on Discord — so every TG scan showed a blank FDV in the contract feed and a `—` in the Radar MC@call and × columns. A Rick embed is still authoritative and now overrides a fallback reading if it lands late
- **Telegram no longer goes quiet** — a network blip, a laptop sleep, or an idle connection could silently kill the update stream, so messages stopped arriving until you restarted. The connection is now health-checked every minute and rebuilt with exponential backoff, and `isConnected()` (the sidebar dot) reflects the real state instead of staying green forever
- **Self-hosted lockdown** — the local backend listened on every network interface with no authentication, so on shared or public Wi-Fi anyone who could reach the port could read your Discord tokens and Telegram session strings. Local mode now binds to `127.0.0.1`; hosted mode still binds `0.0.0.0` for Railway. Set `OCT_HOST` to opt out on a trusted network

## 2026-07-14

### Added
- **Pop-out chat windows** — detach any room, DM, or your Mentions feed into its own native window that keeps streaming live, so you can watch a caller channel on a second monitor while you trade. Click the pop-out icon in a chat header; the chat re-docks automatically when you close the window (desktop app)
- **Automatic EVM chain detection** — when a contract is posted as a bare `0x…` address with no chain mentioned, Trenchcord now resolves its real chain from on-chain liquidity, so the trade link opens on the correct network instead of a default
- **Proxy support** — if Discord won't load behind a VPN, route the gateway and history connection through an HTTP/HTTPS proxy under Settings > General > Connection. Leave it blank to connect directly (desktop app)

### Fixed
- **Desktop app launches again** — the 1.1.0 desktop build could crash on startup and show a blank/black window; it now opens correctly. Update to 1.1.1 if you were affected (desktop app)
- **Connection blocks no longer look like a bad token** — a VPN or datacenter IP block (Discord/Cloudflare rejecting the connection) now shows a distinct `Connection blocked` banner instead of falsely flagging your token as invalid
- **Richer Telegram text** — bold, code blocks, and inline links now render correctly; a formatting-offset bug that could mangle or misplace styled text is fixed, and noise-only links (bare numbers) are dropped to plain text
- **Announcements stay dismissed** — dismissed in-app announcements now persist across restarts instead of reappearing every launch (desktop app)
- **Setup no longer hangs on a spinner** — if your servers can't load during onboarding (for example, a blocked connection), the welcome screen now shows the error with a shortcut to connection settings instead of spinning forever

## 2026-07-13

### Added
- **Split-screen layout** — watch up to 4 rooms, DMs, or your Mentions feed side by side. Add panes with the `+` button in a chat header, then use the layout button in the sidebar to drag, resize, lock, and rearrange them in a single row or two rows. Your layout is saved and restored across restarts
- **Mentions room** — a dedicated room that gathers every message where you, one of your roles, `@here`, or `@everyone` was mentioned across the channels you already monitor. Toggle each mention type under Settings > Mentions
- **Room hotkeys** — assign a single key to any room and press it anywhere (outside a text field) to jump straight to it
- **See who reacted** — click a reaction on a Discord message to see the list of users who reacted with that emoji
- **Unread badges** — the sidebar now shows a blue unread counter on rooms, DMs, and Mentions, clearing the moment you open them
- **Desktop app** — Trenchcord is now available as a native desktop app for Windows and macOS, with auto-updates, keeping your token and data fully on your machine
- **In-app announcements** — important updates and notices can now surface in a dismissible in-app modal
- **Import on setup** — the welcome screen now lets you import an existing `config.json` (token, rooms, and settings) to get going in one step, or continue without a token to explore the app first
- **Local backups include credentials** — in self-hosted mode, settings backups now include your Discord tokens and Telegram credentials so a restore fully reconnects you (hosted mode still never exports credentials — keep local backups somewhere safe)
- **Invalid token indicator** — when Discord rejects a token, it's flagged with a red `Invalid` badge in Settings > Tokens, and errors now name the specific token
- **Community links** — quick Join Discord and X / Twitter buttons in the sidebar
- **Open source under AGPL-3.0** — this release is now licensed under the GNU AGPL-3.0

### Fixed
- **Stable scroll while reading back** — scrolling up now pauses the feed and holds your position instead of drifting as new messages arrive. An `X new messages` pill (with the time of the first one) and a `Jump To Present` banner let you catch up whenever you're ready
- **Smarter token error handling** — connection problems (Discord unreachable, too many connections) are no longer mistaken for an invalid token; only Discord's explicit rejection flags a token as invalid

## 2026-07-02

### Added
- **Deleted message indicator** — messages removed on Discord now stay in the feed with a red `deleted` badge and dimmed styling, so you never miss something that was posted and then pulled
- **Edited message history** — edited messages now show an `(edited)` label; click it to reveal the original text from before the edit
- **Telegram link buttons** — inline keyboard URL buttons (dashboards, charts, etc.) now render as clickable buttons beneath the message
- **Telegram in-text links** — hyperlinks embedded inside Telegram message text now render as clickable links instead of plain text
- **Telegram chat colors** — color-code messages per Telegram chat, just like Discord servers and DMs
- **Telegram basic group support** — legacy Telegram groups now resolve an invite link so their messages link back to the chat and open in the Telegram app

## 2026-06-01

### Fixed
- **Auto-scroll reliability** — chat now stays pinned to the newest message in the cases that previously left it stranded a row or two above the bottom: tall multi-row messages and embeds, several messages arriving at the same time, and reactions added to recent messages. Auto-scroll now chases the live content height every frame until the layout settles (including late-loading images) instead of relying on a fixed-delay smooth scroll, and it gracefully steps aside the moment you scroll up

## 2026-05-04

### Added
- **Display Full Contract Address** — new setting under Settings > Contracts to show contract addresses in their full form instead of the shortened `0x1234...abcd` pill, both in chat and the Contracts dashboard

### Fixed
- **Memory leak on long sessions** — chat tabs running for hours no longer balloon into multiple GB of RAM. All message images (avatars, attachments, embeds, custom emojis, Telegram stickers) now lazy-load, and only the most recent ~200 messages live in the DOM at rest — scroll up to load more in 200-message chunks
- **Re-render performance** — `Message` rows are memoized, so a new incoming WebSocket event no longer re-renders every visible message

## 2026-03-12

### Fixed
- **Auto-scroll reliability** — chat no longer stops auto-scrolling when a reaction or large image appears, even if the user hasn't scrolled up

## 2026-03-06

### Added
- **Telegram integration** — monitor Telegram groups, channels, supergroups, and DMs alongside Discord
- **Telegram setup flow** — connect your Telegram account with phone number, verification code, and optional 2FA
- **Encrypted Telegram credentials** — API ID, API hash, and session strings encrypted at rest with AES-256-GCM (hosted mode)
- **Telegram message rendering** — replies, forwards, stickers, polls, and media displayed natively in the feed
- **Mixed rooms** — combine Discord and Telegram channels in the same room
- **Mobile responsivity** — improved mobile-friendly layouts and touch interactions across the app

### Fixed
- Backend environment configuration

## 2026-03-05

### Added
- **Hosted web app mode** — Trenchcord can now run as a multi-user web app, no installation required
- **Supabase integration** — PostgreSQL database with Row Level Security for per-user data isolation
- **User authentication** — sign up and log in with Email/Password or Discord OAuth
- **Encrypted token storage** — Discord tokens encrypted at rest with AES-256-GCM
- **Per-user Discord gateways** — each user gets their own gateway connection with automatic idle management
- **Profile page** — view account info, login method, and sign out (hosted mode)
- **Sound file storage** — user sounds stored in Supabase Storage for hosted deployments
- **Security hardening** — helmet headers, API rate limiting, CORS restrictions, JWT-authenticated WebSockets, error message sanitization
- **In-memory caching** — server-side cache for config, rooms, and tokens to minimize database round-trips
- **Role colors** — usernames now display their highest Discord role color
- **Compact mode** — denser message layout for power users
- **Custom DM colors** — personalize DM channel name colors
- **DM profile pictures** — avatars now show in DM conversations
- **Background opacity control** — adjust chat background transparency
- **Sound alerts** — configurable notification sounds per channel
- **Chat UI enhancements** — polished message rendering and layout

## 2026-03-04

### Added
- **Sending messages** — reply and send messages directly from Trenchcord
- **Self-host pill** — visual indicator for self-hosted instances

## 2026-03-03

### Added
- **Pushover notifications** — push alerts via Pushover integration
- **Sound settings** — granular control over notification sounds
- **Responsive design** — improved layout for smaller screens
- **Favicon and logo** — custom branding assets
- **Landing page anchors** — smooth scroll navigation on the landing page

### Fixed
- Build issues resolved
- Mobile gate for demo mode

## 2026-03-01

### Added
- **Quick menu user highlighting** — highlight users directly from the right-click menu

## 2026-02-28

### Added
- **Onboarding wizard** — guided setup flow for new users

### Fixed
- Highlight mode behavior
- Highlighting users on click

## 2026-02-27

### Added
- **Search bar** — search through messages
- **Demo mode** — try Trenchcord without connecting a token
- **Live demo on landing page** — embedded demo for visitors
- **CA feed & embeds** — contract address detection and rich embed rendering
- **Global settings** — centralized configuration panel
- **Custom confirm modals** — styled confirmation dialogs
- **Keyword & sound settings** — keyword-based alerts with sound configuration
- **Landing page rework** — redesigned landing page

### Fixed
- Desktop notifications reliability
- Multiple embed messages rendering in a row
- Autocomplete behavior
- Unknown channel handling
- Netlify demo build

## 2026-02-26

### Added
- **Initial release** — core Discord gateway, multi-account support, real-time message streaming
- **Landing page** — project homepage with installation guide
- **Config via JSON** — switched from `.env` to `config.json` for easier setup
- **Open-source section** — added to landing page

### Fixed
- Setup guide first step flow
