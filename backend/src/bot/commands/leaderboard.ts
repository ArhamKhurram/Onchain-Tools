import {
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
} from 'discord.js';
import type { BotLeaderboardResponse } from '@oct/shared';
import { anywhere } from './context.js';
import { getBotLeaderboard } from '../service.js';
import { describeServiceError } from '../errors.js';
import {
  BRAND,
  compactUsd,
  makeContainer,
  makeNavRow,
  makeSeparator,
  makeText,
  noticeCard,
  pnlBadge,
} from '../layout.js';
import type { BotCommand } from './types.js';

const PAGE_SIZE = 10;
const COLLECTOR_MS = 120_000;

function buildComponents(data: BotLeaderboardResponse, page: number, interactionId: string) {
  const totalPages = Math.max(1, Math.ceil(data.entries.length / PAGE_SIZE));
  const pageEntries = data.entries.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const windowLabel = data.window === '24h' ? 'Last 24h' : 'All time';

  const rows = pageEntries.map((e) => {
    const name = e.displayName ?? (e.handle ? `@${e.handle}` : 'Unknown trader');
    const handle = e.handle && e.displayName ? ` \`@${e.handle}\`` : '';
    const pnl = e.pnlUsd !== null ? ` • ${pnlBadge(e.pnlUsd)}` : '';
    const vol = e.volumeUsd !== null ? ` • vol \`${compactUsd(e.volumeUsd)}\`` : '';
    return `${e.rank}. **${name}**${handle}${pnl}${vol}`;
  });

  return {
    components: [
      makeContainer(BRAND.gold, [
        makeText('# 📈 FOMO Leaderboard'),
        makeText(`**Window:** ${windowLabel} · **${data.entries.length}** traders`),
        makeSeparator(1),
        ...(rows.length ? [makeText(rows.join('\n')), makeSeparator(2)] : [makeText('No leaderboard entries found.')]),
        makeText(`-# Page **${page + 1} of ${totalPages}** · Outpost 👀`),
      ]),
      ...(totalPages > 1 ? [makeNavRow('leaderboard', interactionId, page, totalPages)] : []),
    ],
    totalPages,
  };
}

export const leaderboard: BotCommand = {
  data: anywhere(
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Top FOMO traders')
      .addStringOption((o) =>
        o
          .setName('window')
          .setDescription('Time window (default: all time)')
          .setRequired(false)
          .addChoices({ name: 'Last 24 hours', value: '24h' }, { name: 'All time', value: 'all' }),
      )
      .addIntegerOption((o) =>
        o
          .setName('limit')
          .setDescription('How many traders to fetch (1-100, default 25)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(100),
      ),
  ),

  async execute(interaction) {
    await interaction.deferReply();

    const window = interaction.options.getString('window') === '24h' ? '24h' : 'all';
    const limit = interaction.options.getInteger('limit') ?? 25;

    let data: BotLeaderboardResponse;
    try {
      data = await getBotLeaderboard(window, limit);
    } catch (err) {
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: noticeCard(describeServiceError(err, 'fetch the leaderboard')),
      });
      return;
    }

    let page = 0;
    let rendered = buildComponents(data, page, interaction.id);
    const msg = await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: rendered.components,
    });

    if (rendered.totalPages <= 1) return;

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: COLLECTOR_MS,
    });

    collector.on('collect', async (btn: ButtonInteraction) => {
      if (btn.user.id !== interaction.user.id) {
        await btn.reply({ content: 'Only the command user can use these buttons.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (btn.customId.startsWith('leaderboard:first:')) page = 0;
      if (btn.customId.startsWith('leaderboard:prev:')) page = Math.max(0, page - 1);
      if (btn.customId.startsWith('leaderboard:next:')) page = Math.min(rendered.totalPages - 1, page + 1);
      if (btn.customId.startsWith('leaderboard:last:')) page = rendered.totalPages - 1;

      rendered = buildComponents(data, page, interaction.id);
      try {
        await btn.update({ flags: MessageFlags.IsComponentsV2, components: rendered.components });
      } catch (err: any) {
        if (err?.code === 10062) return;
        console.error('[Bot] /leaderboard button error:', err);
      }
    });
  },
};
