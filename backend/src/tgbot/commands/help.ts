import { renderHelp } from '../render.js';
import type { TgCommand } from './types.js';

/** `/help` — the command list. Works whether or not the chat is registered. */
export const help: TgCommand = {
  name: 'help',
  description: 'Show the OCT bot command list',

  async execute(ctx) {
    await ctx.reply(renderHelp());
  },
};
