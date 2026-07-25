import { MessageFlags, type Interaction } from 'discord.js';
import { commandMap } from './commands/index.js';

// Discord drops interactions we answer too late; 10062 = "Unknown interaction".
function isUnknownInteraction(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as any).code === 10062;
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    if (isUnknownInteraction(error)) return;
    console.error(`[Bot] /${interaction.commandName} failed:`, error);

    try {
      const response = {
        content: 'There was an error executing this command.',
        flags: MessageFlags.Ephemeral as const,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response);
      } else {
        await interaction.reply(response);
      }
    } catch (replyError) {
      if (!isUnknownInteraction(replyError)) {
        console.error('[Bot] Failed to send error response:', replyError);
      }
    }
  }
}
