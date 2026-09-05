import type { ParsedCommand } from '../router.js';
import type { TgChat, TgUser } from '../types.js';

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
  reply(text: string): Promise<boolean>;
}

export interface TgCommand {
  /** Lowercase, no slash — matched against ParsedCommand.name. */
  name: string;
  /** One line, ≤256 chars. Fed to @BotFather /setcommands verbatim. */
  description: string;
  execute(ctx: TgCommandContext): Promise<void>;
}
