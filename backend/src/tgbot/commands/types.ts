import type { ParsedCommand } from '../router.js';
import type { TgChat, TgInlineKeyboardMarkup, TgUser } from '../types.js';

/**
 * Everything a command handler is given.
 *
 * `reply` is injected rather than imported so a handler never reaches for the
 * sender directly: it cannot post to another chat, and it cannot bypass the
 * pacing queue. It resolves false when the message was dropped or rejected,
 * which handlers are free to ignore — there is nothing useful to do about it.
 */
export interface TgCommandContext {
  chatId: number;
  chat: TgChat;
  /** The sender, when Telegram supplied one (absent for some channel posts). */
  from: TgUser | null;
  command: ParsedCommand;
  /**
   * `keyboard` attaches an inline keyboard to the reply. Only /start uses it —
   * the panel is the one surface with buttons, and a command that answered with
   * a stray keyboard would leave a second, unmanaged panel in the chat.
   */
  reply(text: string, opts?: { keyboard?: TgInlineKeyboardMarkup }): Promise<boolean>;
}

export interface TgCommand {
  /** Lowercase, no slash — matched against ParsedCommand.name. */
  name: string;
  /** One line, ≤256 chars. Fed to @BotFather /setcommands verbatim. */
  description: string;
  execute(ctx: TgCommandContext): Promise<void>;
}
