import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { BotWalletProfile } from '@oct/shared';
import { anywhere } from './context.js';
import { getBotWallet } from '../service.js';
import { describeServiceError } from '../errors.js';
import { BRAND, makeContainer, makeSeparator, makeText, noticeCard, pnlBadge, usd } from '../layout.js';
import type { BotCommand } from './types.js';

// Public trader lookup — wallets + current holdings + PnL. Ported from the
// standalone Outpost bot's /wallets command; renamed to /wallet ("show me one
// trader") to sit alongside /tracked ("show me my tracked list").
function buildComponents(profile: BotWalletProfile) {
  const { displayName, handle, solAddress, evmAddress, holdings, portfolioPnlUsd, livePerpPnlUsd } = profile;

  const holdingLines = holdings.map(
    (h) => `• ${h.symbol}${h.valueUsd > 0 ? ` • ${usd(h.valueUsd)}` : ''} (${pnlBadge(h.pnlUsd)})`,
  );

  return [
    makeContainer(BRAND.red, [
      makeText(`# 🐂 Wallets & Holdings for ${displayName}`),
      ...(handle ? [makeText(`**Handle:** @${handle}`)] : []),
      ...(solAddress ? [makeText(`**SOL:** \`${solAddress}\``)] : []),
      ...(evmAddress ? [makeText(`**EVM:** \`${evmAddress}\``)] : []),
      makeSeparator(1),
      makeText(holdingLines.length ? `**Top Holdings:**\n${holdingLines.join('\n')}` : 'No current holdings.'),
      makeSeparator(2),
      makeText(`**Portfolio PnL:** ${pnlBadge(portfolioPnlUsd)}`),
      ...(livePerpPnlUsd !== 0 ? [makeText(`**Live Perp PnL:** ${pnlBadge(livePerpPnlUsd)}`)] : []),
      makeText('-# Outpost 👀'),
    ]),
  ];
}

export const wallet: BotCommand = {
  data: anywhere(
    new SlashCommandBuilder()
      .setName('wallet')
      .setDescription("Look up a FOMO trader's wallets and holdings")
      .addStringOption((o) =>
        o.setName('search_term').setDescription('Username, display name, or handle').setRequired(true),
      ),
  ),

  async execute(interaction) {
    await interaction.deferReply();

    const searchTerm = interaction.options.getString('search_term', true).trim();

    try {
      const profile = await getBotWallet(searchTerm);
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: buildComponents(profile),
      });
    } catch (err) {
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: noticeCard(describeServiceError(err, 'look up that trader')),
      });
    }
  },
};
