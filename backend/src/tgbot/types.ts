// Telegram Bot API wire types — hand-written, and only the fields OCT reads.
//
// NOT the same protocol as backend/src/telegram/. That directory is MTProto
// (teleproto): it signs in AS A USER with their session string and reads their
// chats. This is the Bot API — a @BotFather bot token, HTTPS + JSON, and the
// bot sees only what is addressed to it. The two never share code or state.
//
// There is no dependency here on purpose. `node-telegram-bot-api`/`telegraf`
// would pull a framework, a plugin system and a middleware stack in to make
// four `fetch` calls; the surface below is the whole API this bot touches.

/** https://core.telegram.org/bots/api#user */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

/**
 * https://core.telegram.org/bots/api#chat
 *
 * `type` distinguishes a DM ('private') from the group surfaces. Groups are
 * upgraded to supergroups by Telegram without warning — and the chat id CHANGES
 * when that happens (a `migrate_to_chat_id` arrives on the old chat) — so never
 * treat 'group' and 'supergroup' differently.
 */
export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
}

/**
 * https://core.telegram.org/bots/api#messageentity
 *
 * Offsets and lengths are in UTF-16 code units, not code points — an emoji
 * before a command shifts `offset` by 2. router.ts never indexes text by these;
 * it only reads `type === 'bot_command'` and `offset === 0`.
 */
export interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
}

/** https://core.telegram.org/bots/api#message (the fields OCT reads) */
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  entities?: TgMessageEntity[];
}

/** https://core.telegram.org/bots/api#update (the fields OCT reads) */
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
}

/**
 * Every Bot API response is this envelope. A non-2xx HTTP status still carries
 * one, and `parameters.retry_after` on a 429 is the seconds Telegram wants us
 * to wait — sender.ts honours it rather than guessing a backoff.
 */
export interface TgApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

/** Outcome of one API call. Never a rejection — see api.ts. */
export interface TgCallResult<T> {
  ok: boolean;
  result?: T;
  /** Telegram's error_code, or 0 for a transport failure (DNS, timeout, TLS). */
  errorCode: number;
  description?: string;
  /** Seconds Telegram asked us to wait, when it said so. */
  retryAfterSec?: number;
}
