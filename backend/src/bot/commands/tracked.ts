import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { BotTrackedResponse } from '@oct/shared';
import { anywhere } from './context.js';
import { getBotTracked } from '../service.js';
import { describeServiceError } from '../errors.js';
import { BRAND, makeContainer, makeSeparator, makeText, noticeCard } from '../layout.js';
import type { BotCommand } from './types.js';

const MAX_LISTED = 25;

function buildComponents(data: BotTrackedResponse) {
  const { traders } = data;
  if (traders.length === 0) {
    return [
      makeContainer(BRAND.blurple, [
        makeText('# 👛 Your tracked traders'),
        makeText("You aren't tracking any FOMO traders yet."),
        makeText('-# Add them in OCT → Wallets → FOMO, or with `/leaderboard`. · Outpost 👀'),
      ]),
    ];
  }

  const shown = traders.slice(0, MAX_LISTED);
  const rows = shown.map((t, idx) => {
    const name = t.displayName ?? (t.handle ? `@${t.handle}` : 'Unknown trader');
    const handle = t.handle && t.displayName ? ` \`@${t.handle}\`` : '';
    return `${idx + 1}. **${name}**${handle}`;
  });

  const overflow = traders.length - shown.length;

  return [
    makeContainer(BRAND.blurple, [
      makeText('# 👛 Your tracked traders'),
      makeText(`Tracking **${traders.length}** FOMO trader${traders.length === 1 ? '' : 's'}.`),
      makeSeparator(1),
      makeText(rows.join('\n')),
      ...(overflow > 0 ? [makeText(`-# …and ${overflow} more.`)] : []),
      makeText('-# Only you can see this · Outpost 👀'),
    ]),
  ];
}

export const tracked: BotCommand = {
  data: anywhere(
    new SlashCommandBuilder()
      .setName('tracked')
      .setDescription('The FOMO traders your OCT account tracks (only you can see this)'),
  ),

  async execute(interaction) {
    // User-scoped data: always ephemeral so a tracked-trader list never leaks
    // into a public channel (see docs/architecture/discord-bot.md).
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const data = await getBotTracked(interaction.user.id);
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: buildComponents(data),
      });
    } catch (err) {
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: noticeCard(describeServiceError(err, 'load your tracked traders')),
      });
    }
  },
};
