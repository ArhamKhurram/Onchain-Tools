# Changelog

All notable changes to Onchain Tools are documented here. Entries before the
rename still say "Trenchcord" — that was the product's name at the time, and
they're left as the record of what shipped.

## 2026-09-05

### Added
- **Market-cap crossing alerts, chain-wide** — OCT now watches every token it has seen, not just the ones you armed by hand, and pings you the first time one crosses **$750K market cap**. That band is where a coin stops being noise and starts being a position, and it used to be the moment you found out about a day later by scrolling back. It fires once per token on the way up, and it is scam-gated: a token has to clear the same honesty checks the rest of the console uses before it can ping you, so a freshly-minted honeypot printing a fake market cap doesn't get to interrupt you. Your own hand-set price alerts are unchanged and still fire independently.

## 2026-09-04

### Added
- **The console got a proper design pass** — every screen has been rebuilt on one shared set of type, spacing and colour rules. Text is bigger and reads at a glance instead of squinting distance, rows are tighter so more of the thing you came for fits on screen, and status colour now means the same thing everywhere: the same green is the same green on the feed, the portfolio and the radar. Motion is limited to chrome — panels and menus — so nothing animates underneath live data while you're reading it. This landed across the home screen, portfolio, callers, sniper, wallets, the FOMO surfaces, settings and the workspace.
- **Three feed layouts, switchable in the feed** — the contract feed now ships as **three presets** with their own density, and a switcher sits in the feed itself rather than buried in settings. Pick the terminal-style status line if you want maximum rows per screen, or a roomier layout if you read by scanning. Your choice sticks.
- **A first-run checklist** — a fresh install used to open on a screen full of empty panels with no indication of what to do first, which looked identical to something being broken. Every empty surface now says what it will show once it has data and points at the one setting that fills it, and a first-run checklist walks the actual path: connect a source, pick your rooms, arm your alerts.
- **Candlestick charts on pump.fun tokens** — the token panel now draws a real candlestick chart instead of sending you elsewhere to see price action. It loads only when you open a token, so it costs nothing on the rest of the feed.
- **Peak multiple on callouts** — callout rows now carry the same "called at X, ran to Y" multiple the contract feed shows, so a caller's track record reads the same way wherever you meet it.

## 2026-09-03

### Added
- **A Telegram bot — OCT alerts in your group, without handing over credentials** — you can now get OCT's alerts in a Telegram group without connecting a Telegram account to OCT at all. Add the bot, opt the group in, and revival, breakout and price alerts land there. Nothing is on by default: every alert class is opt-in per group, digests are opt-in separately, and the bot fails closed — if it can't confirm a group opted in, it stays quiet rather than guessing. There's a hard ceiling on how much it will ever post in a window and a breaker that trips if something upstream starts flooding, so a runaway signal can't turn your group into a firehose.

### Changed
- **CI runs meaningfully faster** — the typecheck and build phases now run all workspaces concurrently instead of one after another. No behaviour change; releases just land sooner.

## 2026-08-29

### Added
- **Telegram topics are real channels now** — a forum group (a Telegram supergroup with topics, like an alpha group split into *Scanning*, *SOL calls*, *EVM calls*) used to pour everything into one merged stream, and you took all of it or none. Each topic is now its own channel: in room settings → Channels → Telegram, expand a group and pick just the topics you want — the SOL calls without the chatter — exactly the way you pick channels inside a Discord server. Messages are labelled with their topic, contract detections say which group *and* topic they came from, and subscribing to the whole group still gets every topic — nothing about your existing setup changes.
- **A copy button on contract addresses** — clicking an address pill in a message copies it *and* opens the chart, which meant there was no way to just grab the address. Every detected address now carries a small copy icon that copies and nothing else.
- **Hide the caller badges** — a new **Badges** toggle in the Contract Feed toolbar turns off the ELITE/UNRATED chips on rows, for anyone who reads the feed by ticker and wants the row prefix quiet. Ranking and the slop filter still use the bands underneath — only the label goes — and the choice sticks between sessions.

## 2026-08-28

### Fixed
- **Colour changes apply the moment you make them** — picking a colour for a user or a keyword used to lag behind the picker, and sometimes the old colour stuck around until you reloaded. Dragging the picker no longer fires a save on every pixel of movement, saves can't overtake each other and land out of order, and a colour set against an `@handle` now matches the person it was meant for. Setting a colour and seeing it are the same instant again.
- **The chat panes got a lot lighter** — with several panes open on busy rooms, the console was doing far more work than the handful of messages on screen justified. It now renders only the rows near your viewport instead of every message it has ever loaded. With four panes on a full room that is **800 message rows down to about 60**, a colour change that blocked the interface for **~350ms now takes ~67ms**, and fast scrolling that produced **413ms of stalls now produces none**. The whole room is scrollable straight away, too — no more waiting for older messages to page in as you scroll up.
  - Two honest trade-offs: your browser's own Ctrl+F only finds messages currently on screen (the pane's own search still covers everything loaded), and selecting text across a very long stretch of messages stops at the rendered window.

### Notes
- **FOMO trade tracking is paused.** fomo.family is refusing our requests — not an expired token, but the account itself, so reconnecting doesn't help. The trade feed and trader lookup stay quiet until that's resolved. Everything else — the contract feed, revival and breakout alerts, callers, price alerts, the journal — is unaffected.

## 2026-08-24

### Added
- **Peak MC on every call** — contract rows now show what a CA actually did after it was called: the market cap at call, the highest market cap seen since, and the multiple — `FDV 10.2K → 104K · ≥10×`. Check any caller's history at a glance: called at 10K, ran to 100K, that's a caller worth watching. The numbers are honest about how they're gathered — peaks are sampled every few minutes, so every figure is a floor ("at least this high"), a run that happened *before* someone's call is never credited to them, and a token that only bled since the call shows exactly that. Rows update live as new highs print.
- **Caller strength on the CA feed** — every contract row now wears its caller's band: **Elite**, **Solid**, **Mixed**, **Slop** — or an honest **Unrated** when there isn't enough call history to judge (never a made-up neutral score). No more guessing whether a CA came from someone worth following or a random. Hover the badge for the numbers behind it: 2x and 5x hit rates, how many scored calls they're built from, and median reach. Bands measure reach — how often a caller's calls ran after they posted — not realized profit, and the tooltips say so.

## 2026-08-12

### Added
- **FOMO new-join alerts** — when a notable account joins fomo.family, OCT tells you in real time. Joining is the signal: by the time a famous name's first buys hit the feed, the easy entry is gone. The console pings you (notification history + sound), and if you get Pushover alerts for FOMO trades you'll get these too. fomo's own "new traders with smart followers" feed drives it, so it's the same joins the app surfaces — just without you having to be looking. Bursts are capped at five pings a cycle with a "+N more" summary, so a signup wave can't flood you.
- **Breakout alerts** — revival's sibling signal. Revival only fires on tokens that died first; a token consolidating quietly near its highs and then igniting is a different, real setup — and now it gets its own amber alert with its own sound, at normal loudness (the emergency klaxon stays revival-only). Breakouts land in the same Revival log with a kind chip, and get the same 24-hour outcome tracking.
- **Revival receipts** — the Revival tab now opens with the scoreboard: alerts this week, how many tracked to close, median peak multiple, the ≥2× hit rate, and your best catch. No numbers until there's evidence — empty states stay honest.
- **Daily digest DM** — opt in and the Outpost bot DMs you once a day with your revival and breakout alerts and how they played out, the day's top callouts, and who moved on the caller board. Settings → Discord Bot → Daily digest.
- **Price alerts** — pick a token, name a level, get pinged when it crosses. Callers → Alerts. Nothing is detected or scored here: you type "150K mcap, above" and OCT watches it, so a coin you meant to buy in a band can't trade through it while you're away from the screen. It fires once, on the crossing — and the first reading after you arm it is only a baseline, so a token already past your level doesn't ping you the second you set it. Add a note ("entry band from the 4h retest") and it comes back to you in the alert. Toast, notification history and Pushover at normal loudness; the emergency klaxon stays revival-only.
- **"Global first" on the radar** — MC@call shows when *your* rooms first saw a token; the new Global first column shows the earliest call anyone is known to have made. It reads Rick's cross-server first-caller data (`espadabtw @ 49.3K · 10h`) and, on hosted, an anonymous OCT network pool of first sightings — so everyone's coverage helps everyone. The pool stores only the token, when the network first saw it, and the market cap at that moment: never who saw it, or in which group.
- **FOMO trade feed: buy/sell filter and chain icons** — an All/Buys/Sells toggle on the live trade feed hides sells (or buys) when you just want one side, and remembers your choice next time you open it. Each row now shows a small chain glyph for where the trade happened (Solana, Ethereum, BNB Chain, Base, Robinhood) instead of just the chain's three-letter code.
- **Trader lookup now shows how they actually trade** — the FOMO Traders tab listed a trader's addresses, holdings and PnL and nothing about their trading. It now lists their recent swaps and transfers underneath: buy or sell, which token and chain, USD size, and the venue the order routed through, with a running bought-vs-sold total for the window. fomo.family only serves the most recent 100 records and offers no way to page further back, so the list says so instead of implying it's a complete history. The address rows are relabelled in the same pass — they're what fomo.family declares on the profile, not wallets verified on-chain, and because fomo.family holds custody they're typically platform identifiers rather than the trader's own wallet.
- **Callout DMs and a live callout feed** — follow a pump.fun caller and their calls now stream into a new **Pump.fun → Callouts** tab in real time (handle, coin, thesis, and the market cap at the call), and the bot can DM each one straight to you instead of only posting to a channel. Turn DMs on in Settings → Discord Bot → pump.fun callouts, and mute any single caller with the bell on the Following tab. Following nobody used to look identical to a broken feature — the feed now says plainly that it streams the callers you pick and points you at where to add them.
- **Contract Feed collapses repeat rescans** — a token that keeps getting rescanned no longer floods the feed with one full row per scan. Back-to-back scans of the same contract now fold into a single row showing the latest price and a scan count, expandable to see every scan in the burst; a brand-new detection still gets its own prominent row.

### Fixed
- **The Pump.fun token tab stops erroring out** — opening a token sometimes showed a "failed (429)" card instead of its callouts. The tab was asking pump.fun for two things at the same instant and tripping their rate limit on itself; requests now queue, a rate-limited read retries quietly, and a token's callouts are remembered for longer, so reopening one is instant.
- **No more "meta dying" pings on worthless bags** — the alert was firing on rugged positions worth about a dollar, over and over, because a dead bag stays open in the journal forever. It now stays quiet unless the position is actually worth something (default $10, tunable). If we can't price the token at all we still ping you — a missing price isn't proof the bag is empty.
- **Dead bags stop sitting in "open" forever** — a coin that went to zero in value while you still hold every token never tripped the journal's 98%-sold close rule, so it cluttered your open positions and got checked on every cycle for the rest of time. Journal now retires them: no LP at all, or under $100 of it, or worth under a dollar, and untouched for a week. The write-off is honest — the money you never got back is booked as a real loss, so your realized PnL will drop by the cost of every dead bag the first time this runs. That number was always true; it just wasn't being counted. Closed positions have their own tab in the journal, tagged `abandoned`, and nothing is closed on missing data — an unpriceable token is left alone.

## 2026-08-08

### Added
- **Track any pump.fun trader** — a new Pump.fun tab. Paste a wallet and watch their live buys and sells — which coin, how much SOL, and when — plus their realized and unrealized PnL per token, right in the console.
- **Follow the callouts** — read what a trader is calling and the thesis behind it, or paste a token address to see everyone who called it and the market cap they called it at. The top and trending pump.fun communities are there too.

## 2026-08-07

### Added
- **Sniper (alpha)** — a new tab for firing a buy you wrote down in advance. Connect your own Slotshark account, add the wallets you snipe from with a per-fire cap, a daily cap and a limit on open positions, then save a rule: which token, how much, from which wallets, at what slippage. Press fire and OCT sends it, splitting a ladder across wallets and legs, and logs every attempt with the outcome and the reason.
- **Nothing fires by accident.** A new rule is a dry run, and a dry run exercises the full path — including your caps — without moving money. Arming it, taking it live and firing it are three further, separate confirmations. A kill switch on the status bar blocks every buy from the console at once and survives a restart.
- **Your venue token stays yours.** Connecting Slotshark writes the token straight into an encrypted vault from your own browser; it never passes through our servers at connect time and is read only at the moment a buy is sent. It can't be read back afterwards, by anyone. On desktop it stays in your local `.env` and never leaves your machine.

### Notes
- **Triggers still live in Slotshark, not in OCT.** This alpha does not watch Twitter. Automatic tweet-to-buy triggers are the ones in your own Slotshark account — they fire without OCT and OCT is never told, so the caps and kill switch above bind the buys you fire from the console, and only those. The tab says so on every screen.
- A Slotshark API token can sell and withdraw, not just buy, so the funded balance is the amount at risk. Keep it to what you'd accept losing, and rotate the token if you ever doubt it.
- If a send times out, OCT marks it **unknown** rather than retrying — retrying a buy that actually landed buys twice. Check it in Slotshark and resolve the row; the tab keeps a running count of any waiting on you.
- Solana through Slotshark only for now. The Sniper doesn't sell — exits are still yours to manage.

## 2026-08-05

### Fixed
- **Swapping rooms works inside Workspace panels** — the room dropdown in a Workspace room-feed panel opened and listed everything, but picking a room did nothing: it was switching the Feed page's first pane instead of the panel you were looking at. Panels now change their own room, and the choice is saved right away, so it survives a reload without a trip through Customize Layout. Picking a room while editing the layout still waits for Save, like every other layout change.

## 2026-07-31

### Added
- **Top FOMO holders, in the console** — the board you could only get from the bot's `/holders` is now in the app. Hit the holders button on any row in the contract feed for a slide-over showing who on fomo.family holds it, what it's worth to them and their PnL. The chain is detected from the address, so it works for Solana and EVM tokens alike.
- **Token lookup panel** — a new Workspace widget: paste any token address, get the same holders board. For tokens nobody in your rooms has called yet.
- **Trader lookup** — Wallets → Trader Lookup searches any fomo.family trader by handle or name and shows their wallets, holdings and PnL, without tracking them first. The bot's `/wallet`, in the app.

### Changed
- **The FOMO slash commands have retired** — `/holders`, `/leaderboard`, `/tracked` and `/wallet` are gone now that all four live in the console. The bot stays online exactly as before: your DM alerts, release notes and announcements are untouched, and `/token` still works.

### Fixed
- **FOMO data stopped loading after the worker had been up a few days** — holder overlap, the live trade poll and the bot's FOMO commands were all timing out. The worker keeps one browser tab open on fomo.family to get past Cloudflare, and after six days that tab had grown to 577 MB on a 1 GB box — enough to push it into constant swapping, where the same request took anywhere from 2 to 105 seconds. The tab is now recycled periodically, which keeps memory flat and response times steady at ~2s. Nothing was wrong with the FOMO login; no credentials needed rotating.
- **`/holders` found nothing for BNB Chain, Ethereum and Base tokens** — the command assumed Solana whenever you didn't pass `network`, so any `0x…` address came back "No holders found". It now reads the chain off the address and checks every EVM chain FOMO indexes in a single request, so `/holders 0xfe18…7777` just works. Passing `network` explicitly still overrides it.
- **FOMO outages are no longer silent** — a stalled worker used to tie up requests for five minutes and log only `fetch failed`. Requests now time out in 45s and say what actually went wrong.

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
