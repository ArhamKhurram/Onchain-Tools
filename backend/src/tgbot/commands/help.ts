import { SPEC } from '../commandCatalog.js';
import { renderHelp } from '../render.js';
import type { TgCommand } from './types.js';

/** `/help` — the command list. Works whether or not the chat is registered. */
export const help: TgCommand = {
  name: SPEC.help.name,
  description: SPEC.help.description,

  async execute(ctx) {
    await ctx.reply(renderHelp(ctx.botUsername));
  },
};
