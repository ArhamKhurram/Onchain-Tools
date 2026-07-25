import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';

// Slash-command registration script (run manually, not on boot — global
// registration is rate-limited and rarely changes).
//
//   npm run bot:deploy -w backend          → guild deploy when DISCORD_DEV_GUILD_ID
//                                            is set (instant), else global (~1h)
//   npm run bot:deploy -w backend -- --global   → force global
//
// Env: DISCORD_BOT_TOKEN, DISCORD_APP_ID, optional DISCORD_DEV_GUILD_ID.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../.env'), override: false });

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const appId = process.env.DISCORD_APP_ID?.trim();
  const devGuildId = process.env.DISCORD_DEV_GUILD_ID?.trim();
  const forceGlobal = process.argv.includes('--global');

  if (!token || !appId) {
    console.error('[Bot] DISCORD_BOT_TOKEN and DISCORD_APP_ID are required to deploy commands.');
    process.exit(1);
  }

  const body = commands.map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(token);
  const useGuild = !!devGuildId && !forceGlobal;

  const target = useGuild
    ? Routes.applicationGuildCommands(appId, devGuildId!)
    : Routes.applicationCommands(appId);

  console.log(
    `[Bot] Deploying ${body.length} commands ${useGuild ? `to guild ${devGuildId}` : 'globally'}: ${body
      .map((c) => `/${c.name}`)
      .join(', ')}`,
  );

  await rest.put(target, { body });
  console.log(`[Bot] Deployed. ${useGuild ? 'Guild commands are live immediately.' : 'Global commands may take up to an hour to propagate.'}`);
}

main().catch((err) => {
  console.error('[Bot] Command deployment failed:', err);
  process.exit(1);
});
