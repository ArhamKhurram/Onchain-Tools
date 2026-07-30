import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { anywhere } from './context.js';
import { BRAND, botFooter, makeContainer, makeText } from '../layout.js';
import type { BotCommand } from './types.js';

// Liveness probe: proves the in-process bot is wired to the OCT backend.
export const ping: BotCommand = {
  data: anywhere(
    new SlashCommandBuilder().setName('ping').setDescription('Check that the OCT bot is alive'),
  ),
  async execute(interaction) {
    const latency = Math.max(0, Math.round(interaction.client.ws.ping));
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [
        makeContainer(BRAND.green, [
          makeText('# 🛰️ OCT Bot'),
          makeText(`Online — gateway latency \`${latency}ms\`.`),
          makeText(botFooter('Running in-process with the OCT backend')),
        ]),
      ],
    });
  },
};
