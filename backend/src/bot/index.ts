import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { WsServer } from '../ws/server.js';
import { commands } from './commands/index.js';
import { createAlertDmListener } from './alerts.js';
import { handleInteraction } from './interactions.js';

// In-process Outpost bot (DISCORD_BOT_PLAN.md §1). Runs inside the OCT backend
// rather than as a separate service: command handlers call bot/service.ts
// directly, so there is no HTTP hop and no second deploy target.
//
// SAFETY: the bot is strictly optional. It self-gates on DISCORD_BOT_TOKEN, and
// every failure path is swallowed + logged — a bot problem must never take down
// the OCT backend (feed ingestion, API, WS).

let client: Client | null = null;

export function getBotClient(): Client | null {
  return client;
}

export function isBotEnabled(): boolean {
  return !!process.env.DISCORD_BOT_TOKEN?.trim();
}

export function startBot(wsServer?: WsServer): void {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    console.log('[Bot] DISCORD_BOT_TOKEN not set; Outpost bot disabled.');
    return;
  }

  try {
    // Slash commands only — no privileged intents, no message content.
    const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

    bot.once(Events.ClientReady, (ready) => {
      console.log(
        `[Bot] Outpost online as ${ready.user.tag} (${commands.length} commands registered in-process).`,
      );
    });

    bot.on(Events.InteractionCreate, (interaction) => {
      void handleInteraction(interaction).catch((err) => {
        console.error('[Bot] Unhandled interaction error:', err);
      });
    });

    // discord.js emits 'error' for gateway/network problems; without a listener
    // Node would treat it as an unhandled 'error' event and crash the process.
    bot.on(Events.Error, (err) => console.error('[Bot] Client error:', err?.message ?? err));
    bot.on(Events.Warn, (msg) => console.warn('[Bot] Warning:', msg));

    client = bot;

    // Alert DMs (opt-in per user). Subscribing to the WS alert seam means no
    // changes at any of the alert emission sites.
    if (wsServer) {
      wsServer.onAlert(createAlertDmListener(getBotClient));
    }

    void bot.login(token).catch((err) => {
      console.error('[Bot] Discord login failed; bot disabled for this process:', err?.message ?? err);
      client = null;
    });
  } catch (err) {
    console.error('[Bot] Failed to start; continuing without the bot:', (err as Error)?.message ?? err);
    client = null;
  }
}

export async function stopBot(): Promise<void> {
  if (!client) return;
  try {
    await client.destroy();
  } catch (err) {
    console.error('[Bot] Error during shutdown:', (err as Error)?.message ?? err);
  } finally {
    client = null;
  }
}
