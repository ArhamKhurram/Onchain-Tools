import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { anywhere } from './context.js';
import { getBotSnapshot } from '../service.js';
import { describeServiceError } from '../errors.js';
import {
  BRAND,
  compactUsd,
  makeContainer,
  makeSeparator,
  makeText,
  noticeCard,
  shortAddress,
} from '../layout.js';
import type { BotCommand } from './types.js';

// Token snapshot from OCT's enrichment catalog (GMGN → DexScreener fallback).
export const token: BotCommand = {
  data: anywhere(
    new SlashCommandBuilder()
      .setName('token')
      .setDescription('Market snapshot for a token from OCT enrichment')
      .addStringOption((o) =>
        o.setName('address').setDescription('Token contract address').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('chain')
          .setDescription('Chain slug (sol, eth, bsc, base, …) — default sol')
          .setRequired(false),
      ),
  ),

  async execute(interaction) {
    await interaction.deferReply();

    const address = interaction.options.getString('address', true).trim();
    const chain = (interaction.options.getString('chain') ?? 'sol').trim().toLowerCase();

    try {
      const snap = await getBotSnapshot(chain, address);

      if (!snap.found) {
        await interaction.editReply({
          flags: MessageFlags.IsComponentsV2,
          components: noticeCard(`🔍 No enrichment data found for \`${shortAddress(address)}\` on \`${chain}\`.`),
        });
        return;
      }

      const ticker = (snap.symbol ?? 'TOKEN').toUpperCase();
      const lines = [
        snap.marketCap ? makeText(`**MCap:** ${snap.marketCapDisplay ?? compactUsd(snap.marketCap)}`) : null,
        snap.priceUsd
          ? makeText(`**Price:** $${snap.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}`)
          : null,
        snap.liquidityUsd ? makeText(`**Liquidity:** ${compactUsd(snap.liquidityUsd)}`) : null,
      ].filter(Boolean) as ReturnType<typeof makeText>[];

      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [
          makeContainer(BRAND.blurple, [
            makeText(`# 💠 $${ticker}${snap.name && snap.name !== ticker ? ` — ${snap.name}` : ''}`),
            makeText(`**Chain:** \`${snap.chain}\` · \`${shortAddress(snap.address)}\``),
            makeSeparator(1),
            ...(lines.length ? lines : [makeText('_No market data available._')]),
            makeText(
              `-# Source: ${snap.source ?? 'unknown'}${snap.stale ? ' (stale)' : ''} · Outpost 👀`,
            ),
          ]),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: noticeCard(describeServiceError(err, 'fetch the token snapshot')),
      });
    }
  },
};
