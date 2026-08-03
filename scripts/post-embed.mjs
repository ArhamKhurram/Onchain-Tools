// One-off: post a branded OCT links card to a Discord channel.
//
// Standalone utility — NOT part of the backend or CI. It logs in with the same
// DISCORD_BOT_TOKEN the in-process bot uses, uploads the banner + logo as
// message attachments, and posts a Components V2 container that references them
// via attachment:// (so nothing needs to be hosted anywhere).
//
// Usage (from repo root):
//   node scripts/post-embed.mjs
//
// Config via env (or a backend/.env file, which this script auto-loads):
//   DISCORD_BOT_TOKEN   required — the bot must be able to View Channel +
//                       Send Messages in the target channel.
//   OCT_EMBED_CHANNEL   target channel id (default: the one below)
//   OCT_EMBED_BANNER    path to the banner image (default: ./scripts/assets/banner.png)
//   OCT_EMBED_LOGO      path to the logo image   (default: ./scripts/assets/logo.png)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client, GatewayIntentBits, MessageFlags, AttachmentBuilder } from 'discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// --- tiny .env loader (backend/.env holds the token in local dev) -----------
function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val; // never clobber real env
  }
}
loadEnv(resolve(repoRoot, 'backend/.env'));
loadEnv(resolve(repoRoot, '.env'));

// --- config -----------------------------------------------------------------
const TOKEN = process.env.DISCORD_BOT_TOKEN?.trim();
const CHANNEL_ID = (process.env.OCT_EMBED_CHANNEL || '1530599001513001143').trim();
const BANNER = resolve(repoRoot, process.env.OCT_EMBED_BANNER || 'scripts/assets/banner.png');
const LOGO = resolve(repoRoot, process.env.OCT_EMBED_LOGO || 'scripts/assets/logo.png');

const SITE_ACCENT = 0xff2a2a; // matches bot/layout.ts SITE_ACCENT

const LINKS = [
  { label: 'X / Twitter', url: 'https://x.com/toolsonchain' },
  { label: 'Website', url: 'https://www.onchaintools.tech/' },
];

// --- preflight --------------------------------------------------------------
function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!TOKEN) die('DISCORD_BOT_TOKEN is not set (checked env, backend/.env, .env).');
if (!existsSync(BANNER)) die(`Banner image not found at:\n    ${BANNER}\n  Set OCT_EMBED_BANNER or drop a banner.png there.`);
if (!existsSync(LOGO)) die(`Logo image not found at:\n    ${LOGO}\n  Set OCT_EMBED_LOGO or drop a logo.png there.`);

// --- Components V2 payload ---------------------------------------------------
// Container (17) → Section (9) with logo thumbnail accessory (11)
//              → Separator (14)
//              → Media gallery (12) holding the banner
//              → Separator (14)
//              → Action row (1) of link buttons (2, style 5)
//              → footer text (10)
const components = [
  {
    type: 17,
    accent_color: SITE_ACCENT,
    components: [
      {
        type: 9,
        components: [
          { type: 10, content: '# Onchain Tools' },
          { type: 10, content: '-# Real-time crypto intelligence console' },
          { type: 10, content: 'FEED · RADAR · CONVERGENCE · MISSED RUNNERS' },
        ],
        accessory: { type: 11, media: { url: 'attachment://logo.png' } },
      },
      { type: 14, spacing: 1, divider: true },
      { type: 12, items: [{ media: { url: 'attachment://banner.png' } }] },
      { type: 14, spacing: 1, divider: true },
      {
        type: 1,
        components: LINKS.map((l) => ({ type: 2, style: 5, label: l.label, url: l.url })),
      },
      { type: 10, content: '-# OCT · Onchain Tools' },
    ],
  },
];

const files = [
  new AttachmentBuilder(BANNER, { name: 'banner.png' }),
  new AttachmentBuilder(LOGO, { name: 'logo.png' }),
];

// --- send -------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async (ready) => {
  console.log(`✓ Logged in as ${ready.user.tag}`);
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !('send' in channel)) die(`Channel ${CHANNEL_ID} is missing or not a text channel the bot can post to.`);

    const sent = await channel.send({ flags: MessageFlags.IsComponentsV2, components, files });
    console.log(`✓ Posted to #${channel.name ?? CHANNEL_ID} — message ${sent.id}`);
  } catch (err) {
    if (err?.code === 50001) die('Missing Access — grant the bot View Channel in that channel.');
    if (err?.code === 50013) die('Missing Permissions — grant the bot Send Messages + Embed Links there.');
    die(`Send failed: ${err?.message ?? err}`);
  } finally {
    await client.destroy();
  }
});

client.login(TOKEN).catch((err) => die(`Login failed: ${err?.message ?? err}`));
