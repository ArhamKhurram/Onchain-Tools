import { isEvmAddress } from '@oct/shared';
import { getBotSnapshot } from '../../bot/service.js';
import { describeServiceError } from '../errors.js';
import { escapeHtml, joinLines } from '../html.js';
import { footer, renderTokenSnapshot } from '../render.js';
import type { TgCommand } from './types.js';

/**
 * `/token <address> [chain]` — market snapshot from OCT's enrichment catalog.
 *
 * The Telegram twin of the Discord /token command, and deliberately the same
 * ONE call: getBotSnapshot in bot/service.ts, which reads the shared catalog
 * (GMGN → DexScreener). Nothing about enrichment is reimplemented here — this
 * command is a transport, and the numbers must match what the console shows.
 *
 * Chain defaults to `sol`, exactly as the slash command does, except that an
 * `0x…` address defaults to `eth`: it is definitely not Solana, and asking the
 * catalog for a Solana token at an EVM address can only miss.
 */
export const token: TgCommand = {
  name: 'token',
  description: 'Market snapshot for a token address',

  async execute(ctx) {
    const address = ctx.command.args[0]?.trim();
    if (!address) {
      await ctx.reply(
        joinLines([
          escapeHtml('Usage: /token <address> [chain]'),
          escapeHtml('Example: /token So11111111111111111111111111111111111111112'),
          footer(),
        ]),
      );
      return;
    }

    // Cheap sanity bound before spending an enrichment lookup on chat noise.
    if (address.length < 32 || address.length > 64) {
      await ctx.reply(joinLines([escapeHtml('That does not look like a token address.'), footer()]));
      return;
    }

    const chain = (ctx.command.args[1] ?? (isEvmAddress(address) ? 'eth' : 'sol')).trim().toLowerCase();

    try {
      await ctx.reply(renderTokenSnapshot(await getBotSnapshot(chain, address)));
    } catch (err) {
      await ctx.reply(
        joinLines([escapeHtml(describeServiceError(err, 'fetch the token snapshot')), footer()]),
      );
    }
  },
};
