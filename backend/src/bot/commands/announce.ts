import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { SITE_ACCENT, makeContainer, makeImage, makeSeparator, makeText } from '../layout.js';
import type { BotCommand } from './types.js';

const KIND_META = {
  site: { icon: '🌐', label: 'Site update' },
  bot: { icon: '🤖', label: 'Bot update' },
} as const;

export type AnnounceKind = keyof typeof KIND_META;

export interface AnnouncePayload {
  title: string;
  description: string;
  kind: AnnounceKind;
  imageUrl?: string | null;
  linkUrl?: string | null;
}

/** Pure render — matches the site's red/black brand via Components V2. */
export function buildAnnouncementComponents(payload: AnnouncePayload) {
  const { title, description, kind, imageUrl, linkUrl } = payload;
  const meta = KIND_META[kind];

  return [
    makeContainer(SITE_ACCENT, [
      makeText(`# ${meta.icon} ${title}`),
      makeText(`-# ${meta.label}`),
      makeSeparator(1),
      makeText(description),
      ...(imageUrl ? [makeSeparator(1), makeImage(imageUrl)] : []),
      ...(linkUrl ? [makeText(`[Open →](${linkUrl})`)] : []),
      makeText('-# OCT · Onchain Tools'),
    ]),
  ];
}

// Posts a styled update announcement to a fixed channel. Guild-only (no
// anywhere()/UserInstall) and admin-gated via Discord's own permission system
// — a DM-installed copy of the bot has no guild permission context to check,
// so this command deliberately opts out of that to stay admin-only.
export const announce: BotCommand = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post a styled update announcement to the announcements channel (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('title').setDescription('Headline').setRequired(true))
    .addStringOption((o) =>
      o.setName('description').setDescription('What changed').setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName('kind')
        .setDescription('Site or bot update (default: site)')
        .setRequired(false)
        .addChoices({ name: 'Site update', value: 'site' }, { name: 'Bot update', value: 'bot' }),
    )
    .addStringOption((o) =>
      o.setName('image').setDescription('Screenshot URL (optional)').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('link').setDescription('Link to open, e.g. the dashboard (optional)').setRequired(false),
    ) as SlashCommandBuilder,

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channelId = process.env.DISCORD_ANNOUNCE_CHANNEL_ID?.trim();
    if (!channelId) {
      await interaction.editReply('⚠️ DISCORD_ANNOUNCE_CHANNEL_ID is not configured on this OCT instance.');
      return;
    }

    const payload: AnnouncePayload = {
      title: interaction.options.getString('title', true).trim(),
      description: interaction.options.getString('description', true).trim(),
      kind: (interaction.options.getString('kind') as AnnounceKind) ?? 'site',
      imageUrl: interaction.options.getString('image')?.trim() || null,
      linkUrl: interaction.options.getString('link')?.trim() || null,
    };

    try {
      const channel = await interaction.client.channels.fetch(channelId);
      if (!channel || !('send' in channel) || channel.type === ChannelType.GuildVoice) {
        await interaction.editReply('⚠️ Configured announcement channel is missing or not postable.');
        return;
      }

      await (channel as any).send({
        flags: MessageFlags.IsComponentsV2,
        components: buildAnnouncementComponents(payload),
      });

      await interaction.editReply(`✅ Posted to <#${channelId}>.`);
    } catch (err: any) {
      if (err?.code === 50001 || err?.code === 50013) {
        await interaction.editReply(
          "⚠️ I don't have permission to post in that channel. Grant me View Channel + Send Messages + Embed Links there.",
        );
        return;
      }
      console.error('[Bot] /announce failed:', err?.message ?? err);
      await interaction.editReply('❌ Failed to post the announcement.');
    }
  },
};
