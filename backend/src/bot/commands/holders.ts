import {
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
} from 'discord.js';
import type { BotHoldersResponse } from '@oct/shared';
import { anywhere } from './context.js';
import { DEFAULT_NETWORK_ID, getBotHolders, resolveNetworkId } from '../service.js';
import { describeServiceError } from '../errors.js';
import {
  BRAND,
  compactUsd,
  makeContainer,
  makeNavRow,
  makeSection,
  makeSeparator,
  makeText,
  makeThumbnail,
  noticeCard,
  pnlBadge,
  shortAddress,
  usd,
} from '../layout.js';
import type { BotCommand } from './types.js';

const PAGE_SIZE = 10;
const COLLECTOR_MS = 120_000;

// Renders one page of the holders board. Ported from the standalone Outpost
// bot's buildComponents(), reading the BotHoldersResponse DTO instead of raw
// FOMO JSON.
function buildComponents(data: BotHoldersResponse, page: number, interactionId: string) {
  const { token, holders, explorerBase } = data;
  const totalPages = Math.max(1, Math.ceil(holders.length / PAGE_SIZE));
  const pageHolders = holders.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const ticker = (token.symbol ?? 'TOKEN').toUpperCase();
  const tokenName = token.name ?? ticker;

  const rows = pageHolders.map((h) => {
    const nameLink = h.address ? `[**${h.name}**](${explorerBase}${h.address})` : `**${h.name}**`;
    return `${h.rank}. ${nameLink} • \`${usd(h.valueUsd)} (${pnlBadge(h.pnlUsd)})\``;
  });

  const socials: string[] = [];
  if (token.socials.twitter) socials.push(`[Twitter](${token.socials.twitter})`);
  if (token.socials.telegram) socials.push(`[Telegram](${token.socials.telegram})`);
  if (token.socials.website) socials.push(`[Website](${token.socials.website})`);

  const tokenLine =
    tokenName && tokenName !== ticker
      ? `**Token:** [${tokenName}](${explorerBase}${token.address}) (\`${shortAddress(token.address)}\`)`
      : `**Token:** \`${shortAddress(token.address)}\``;

  const introMain = [makeText(`# 🏆 Top Fomo Holders for $${ticker}`), makeText(tokenLine)];

  const introMeta = [
    token.marketCap ? makeText(`**MCap:** ${compactUsd(token.marketCap)}`) : null,
    token.priceUsd && token.priceUsd > 0
      ? makeText(`**Price:** $${token.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}`)
      : null,
    token.description
      ? makeText(
          `**About:** ${token.description.length > 220 ? `${token.description.slice(0, 217)}...` : token.description}`,
        )
      : null,
    socials.length ? makeText(socials.join(' · ')) : null,
  ].filter(Boolean) as ReturnType<typeof makeText>[];

  const body = rows.length ? [makeText(rows.join('\n')), makeSeparator(2)] : [makeText('No holders found.')];
  const footer = makeText(`-# Page **${page + 1} of ${totalPages}** · Outpost 👀`);

  return {
    components: [
      makeContainer(BRAND.red, [
        ...(token.iconUrl ? [makeSection(makeThumbnail(token.iconUrl, tokenName), introMain)] : introMain),
        ...introMeta,
        makeSeparator(1),
        ...body,
        footer,
      ]),
      ...(totalPages > 1 ? [makeNavRow('holders', interactionId, page, totalPages)] : []),
    ],
    totalPages,
  };
}

export const holders: BotCommand = {
  data: anywhere(
    new SlashCommandBuilder()
      .setName('holders')
      .setDescription('Top FOMO holders for a token')
      .addStringOption((o) =>
        o.setName('token_address').setDescription('Token contract address').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('network')
          .setDescription('Chain slug (sol, eth, bsc, base, hood) or FOMO network id — default Solana')
          .setRequired(false),
      ),
  ),

  async execute(interaction) {
    await interaction.deferReply();

    const tokenAddress = interaction.options.getString('token_address', true).trim();
    const networkInput = interaction.options.getString('network');
    const networkId = networkInput ? resolveNetworkId(networkInput) : DEFAULT_NETWORK_ID;

    if (!networkId) {
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: noticeCard(
          `Unsupported network \`${networkInput}\`. Try \`sol\`, \`eth\`, \`bsc\`, \`base\`, \`hood\`, or a FOMO network id.`,
        ),
      });
      return;
    }

    let data: BotHoldersResponse;
    try {
      data = await getBotHolders(tokenAddress, networkId);
    } catch (err) {
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: noticeCard(describeServiceError(err, 'fetch holders')),
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
      if (btn.customId.startsWith('holders:first:')) page = 0;
      if (btn.customId.startsWith('holders:prev:')) page = Math.max(0, page - 1);
      if (btn.customId.startsWith('holders:next:')) page = Math.min(rendered.totalPages - 1, page + 1);
      if (btn.customId.startsWith('holders:last:')) page = rendered.totalPages - 1;

      rendered = buildComponents(data, page, interaction.id);
      try {
        await btn.update({ flags: MessageFlags.IsComponentsV2, components: rendered.components });
      } catch (err: any) {
        if (err?.code === 10062) return; // interaction expired — nothing to do
        console.error('[Bot] /holders button error:', err);
      }
    });
  },
};
