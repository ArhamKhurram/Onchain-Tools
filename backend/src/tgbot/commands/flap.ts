// `/flap test` — the operator dry-run for the Flap new-stock alert.
//
// WHAT IT DOES. It pulls the MOST RECENT real stock listing off-chain (a bounded
// recent scan, flap/poller.ts) and sends that chat the card AS IT WOULD APPEAR
// — heading, chain, tap-to-copy CA, quick-buy keyboard — to the requester ONLY.
// It touches NONE of the known-asset state and fans out to nobody: it is the
// on-demand "does the pipeline work" check, not a delivery.
//
// GATING — the same operator gate `/fees` uses, minus the resolved-account
// requirement (a dry run needs no linked OCT account). Three conditions, in
// order: PRIVATE CHAT ONLY (a group is refused before anything else), the
// chat-write rule (ctx.authorizeWrite → the private chat's own owner), and the
// TG_BOT_SNIPER_OPERATORS allowlist by Telegram user id (UNSET MEANS NOBODY, so
// the command is dark until an operator names themselves). A stranger learns
// only that the command exists and that they are not on it.

import { flapTestListing, flapWatchedChains, isFlapEnabled } from '../../flap/poller.js';
import { SPEC } from '../commandCatalog.js';
import { escapeHtml, joinLines } from '../html.js';
import { footer, flapStockQuickBuyKeyboard, renderFlapStockCard } from '../render.js';
import { readSniperOperators } from '../sniperAccess.js';
import type { TgCommand, TgCommandContext } from './types.js';

async function say(ctx: TgCommandContext, text: string): Promise<void> {
  await ctx.reply(joinLines([escapeHtml(text), footer()]));
}

export const flap: TgCommand = {
  name: SPEC.flap.name,
  description: SPEC.flap.description,

  async execute(ctx) {
    const sub = (ctx.command.args[0] ?? '').trim().toLowerCase();
    if (sub !== 'test') {
      await say(ctx, 'Usage: /flap test — preview the most recent Flap stock listing.');
      return;
    }

    // 1. Private only — a group is refused before the operator check, so a
    //    diagnostic card never lands in a room.
    if (ctx.chat.type !== 'private') {
      await say(ctx, 'This command is private-chat only. Message the bot directly.');
      return;
    }

    if (!ctx.from) {
      await say(ctx, 'This command needs a signed-in Telegram sender.');
      return;
    }

    // 2. The operator allowlist. Unset = nobody, deliberately.
    const operators = readSniperOperators();
    if (!operators || !operators.has(ctx.from.id)) {
      await say(ctx, 'You are not authorized to use this command.');
      return;
    }

    // 3. The one chat-write rule (in a private chat: the owner), called not restated.
    const write = await ctx.authorizeWrite();
    if (!write.allow) {
      await say(ctx, write.message);
      return;
    }

    // --- Authorized. Run the dry run. ---
    if (!isFlapEnabled()) {
      await say(ctx, 'The Flap stock watcher is disabled on this instance.');
      return;
    }
    if (flapWatchedChains().length === 0) {
      await say(
        ctx,
        'No Flap chain is configured here — set OCT_FLAP_BSC_RPC_URL or PINAX_API_KEY (BNB), ' +
          'and OCT_FLAP_ROBINHOOD_RPC_URL + OCT_FLAP_ROBINHOOD_VAULTPORTAL (Robinhood).',
      );
      return;
    }

    let listing;
    try {
      listing = await flapTestListing();
    } catch {
      listing = null;
    }
    if (!listing) {
      await say(ctx, 'Could not find a recent Flap stock listing on-chain right now. Try again shortly.');
      return;
    }

    const view = {
      symbols: listing.symbols,
      network: listing.network,
      firstTokenAddress: listing.firstTokenAddress,
    };
    await ctx.reply(renderFlapStockCard(view), {
      keyboard: flapStockQuickBuyKeyboard({
        address: view.firstTokenAddress,
        network: view.network,
      }),
    });
  },
};
