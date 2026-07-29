import { ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import type { BotCommandData } from './types.js';

/**
 * Make a command usable **in guilds and in DMs** (see docs/architecture/discord-bot.md):
 * installable both to servers and to individual users, and invocable from a
 * guild channel, the bot's DM, or a group/private channel.
 */
export function anywhere<T extends BotCommandData>(builder: T): T {
  builder
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    );
  return builder;
}
