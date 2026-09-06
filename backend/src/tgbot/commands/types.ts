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
   * The bot's own @username from getMe; '' when Telegram returned none.
   *
   * Injected for the same reason `reply` is: a handler that imported it would
   * be reaching for process state, and the help card is a pure renderer whose
   * test has to be able to hand it an empty username. See identity.ts.
   */
  botUsername: string;
  /**
   * May the sender CHANGE this chat's settings?
   *
   * Resolves the same rule the /start panel's buttons use — group writes need a
   * creator or administrator, private chats need the chat's own owner — through
   * the same cache, and FAILS CLOSED when Telegram cannot be asked. Handlers
   * call it only on the branch that is about to write: a read must never spend
   * a getChatMember round trip. See permissions.ts.
   */
  authorizeWrite(): Promise<{ allow: boolean; message: string }>;
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
  /**
   * One line, ≤256 chars. Sent to Telegram by setMyCommands at boot, which is
   * what puts the command in the `/` autocomplete menu.
   *
   * Handlers read both fields out of commandCatalog.ts rather than declaring
   * them inline, so the menu entry, the help card and the handler cannot name
   * the same command three different ways.
   */
  description: string;
  execute(ctx: TgCommandContext): Promise<void>;
}
