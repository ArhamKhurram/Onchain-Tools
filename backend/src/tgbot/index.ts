// The OCT Telegram bot: alerts and lookups delivered into a Telegram chat with
// NO credential handover.
//
// WHY IT EXISTS. Using OCT today means pasting a Discord token or a Telegram
// session string into it, and that is the product's single biggest activation
// blocker — the objection is trust, not features. A @BotFather bot added to a
// group inverts the arrangement: the bot carries its own token, it can only see
// messages addressed to it, and no user account is connected to anything.
//
// NOT THE MTPROTO CLIENT. backend/src/telegram/ signs in AS A USER (teleproto)
// to ingest their chats. This is the Bot API. The two share no code, no state
// and no credentials, and this module must never reach into that one.
//
// SAFETY, same contract as the Discord bot in bot/index.ts:
//   • self-gates on TELEGRAM_BOT_TOKEN — unset, it logs once and idles
//   • every failure path is swallowed and logged; a bot problem must never take
//     down feed ingestion, the API or the WS server
//   • the token is read from env, held in one private field, and never logged
//
// LONG POLLING, NOT WEBHOOKS. A webhook needs a stable public HTTPS path that
// survives Railway's deploy churn, plus a secret-token check and a route
// mounted outside /api. getUpdates needs none of that, costs one idle HTTPS
// connection, and works identically in local mode on a laptop.

import type { WsServer } from '../ws/server.js';
import { describeCallError, looksLikeBotToken, TelegramBotApi } from './api.js';
import { DECLINE_MESSAGE, readAllowedChatIds } from './access.js';
import { getChatStore } from './chatStore.js';
import { commandMap } from './commands/index.js';
import { classifyUpdate, nextOffset } from './router.js';
import { TelegramSender } from './sender.js';
import { TgAlertRouter } from './alerts.js';
import { readDigestIntervalMs } from './digest.js';

/** Seconds Telegram holds an empty getUpdates open before answering. */
const POLL_SECONDS = 30;

/** Backoff bounds for a failing poll. */
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

interface BotState {
  sender: TelegramSender;
  /** Resolves when the poll loop has actually exited. */
  loop: Promise<void>;
}

let state: BotState | null = null;
/**
 * The controller for the current lifetime, created by start() BEFORE the async
 * boot. Without it a stop() arriving during boot (a SIGTERM seconds after
 * deploy) would be swallowed and the poll loop would come up orphaned.
 */
let lifetime: AbortController | null = null;

/**
 * The alert fan-out. Created once for the PROCESS, not once per start, for two
 * reasons: WsServer.onAlert has no unregister, so a stop()/start() pair would
 * otherwise leave two listeners delivering every alert twice; and the guard's
 * rate windows are the thing standing between a chat and a flood, so a restart
 * must not hand a chat a fresh budget.
 */
let alertRouter: TgAlertRouter | null = null;
let digestTimer: NodeJS.Timeout | null = null;

function getAlertRouter(): TgAlertRouter {
  if (!alertRouter) alertRouter = new TgAlertRouter(getSender);
  return alertRouter;
}

export function isTelegramBotEnabled(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN?.trim();
}

/** The live sender, or null when the bot is not running. Used by alerts.ts. */
function getSender(): TelegramSender | null {
  return state?.sender ?? null;
}

/**
 * Start the bot. Returns immediately; the poll loop runs in the background.
 *
 * Registering the alert listener happens BEFORE the async boot so an alert
 * raised during startup is not lost — the listener resolves the sender lazily
 * and no-ops while there is none.
 */
export function startTelegramBot(wsServer?: WsServer): void {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.log('[TgBot] TELEGRAM_BOT_TOKEN not set; Telegram bot disabled.');
    return;
  }
  if (state || lifetime) {
    console.warn('[TgBot] Already running; ignoring a second start.');
    return;
  }
  if (!looksLikeBotToken(token)) {
    // Fail loudly at boot rather than as a 401 on every poll forever. The token
    // itself is NOT echoed — only the fact that its shape is wrong.
    console.error(
      '[TgBot] TELEGRAM_BOT_TOKEN does not look like a @BotFather token (expected `<digits>:<secret>`); bot disabled.',
    );
    return;
  }

  const abort = new AbortController();
  lifetime = abort;
  // Registered once per process — see getAlertRouter. `alertRouter` being null
  // is exactly "this listener has never been attached".
  if (wsServer && !alertRouter) wsServer.onAlert(getAlertRouter().listener());
  startDigestTimer();

  void boot(token, abort).catch((err) => {
    console.error('[TgBot] Failed to start; continuing without it:', (err as Error)?.message ?? err);
    abandon(abort);
  });
}

/**
 * Give up on a boot, but only if this lifetime is still the current one — a
 * stop()+start() pair that raced the boot would otherwise have its NEW
 * controller cleared by the OLD boot's cleanup, leaving the bot unstoppable.
 */
function abandon(abort: AbortController): void {
  if (lifetime === abort) {
    lifetime = null;
    state = null;
  }
}

async function boot(token: string, abort: AbortController): Promise<void> {
  const api = new TelegramBotApi(token);

  const me = await api.getMe(abort.signal);
  if (!me.ok || !me.result) {
    console.error(`[TgBot] ${describeCallError('getMe', me)} — bot disabled for this process.`);
    abandon(abort);
    return;
  }
  // A stop() that arrived while getMe was in flight.
  if (abort.signal.aborted) {
    abandon(abort);
    return;
  }

  const username = me.result.username ?? '';
  const sender = new TelegramSender(api, {
    onPermanentFailure: (chatId, reason) => {
      void getChatStore().disable(chatId, reason);
    },
  });

  // Last check before we take ownership: a stop() between here and the getMe
  // check above would otherwise leave a dead loop registered as "running".
  if (lifetime !== abort || abort.signal.aborted) {
    abandon(abort);
    return;
  }

  const allowlist = readAllowedChatIds();
  console.log(
    `[TgBot] Online as @${username} (${commandMap.size} commands, ` +
      `${allowlist ? `${allowlist.size} allowlisted chat(s)` : 'no chat allowlist — serving any chat that runs /start'}).`,
  );

  state = { sender, loop: pollLoop(api, sender, username, abort.signal) };
}

/**
 * The poll loop.
 *
 * `offset` is an acknowledgement, not a cursor: it is advanced past every
 * update in a batch whether or not the batch produced any action, because an
 * unconfirmed update is redelivered forever. It advances only AFTER the batch
 * has been handled, so a crash mid-batch replays rather than drops.
 */
async function pollLoop(
  api: TelegramBotApi,
  sender: TelegramSender,
  username: string,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0;
  let backoff = BACKOFF_START_MS;

  while (!signal.aborted) {
    const result = await api.getUpdates(offset, POLL_SECONDS, signal);

    if (signal.aborted) break;

    if (!result.ok) {
      // 409 is the one worth naming: it means a SECOND process (another deploy,
      // a local dev server, a webhook still set) is polling the same token, and
      // Telegram hands each update to only one of them. Silent message loss
      // otherwise looks like a bug in this code.
      if (result.errorCode === 409) {
        console.error(
          '[TgBot] Another process is polling this bot token (409). Updates will be split between them — ' +
            'stop the other instance, or use a separate token per environment.',
        );
      } else {
        console.error(`[TgBot] ${describeCallError('getUpdates', result)}; retrying in ${backoff}ms.`);
      }
      // Telegram's own retry_after wins over our backoff when it gave one.
      const waitMs = result.retryAfterSec ? result.retryAfterSec * 1000 : backoff;
      await sleep(waitMs, signal);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }

    backoff = BACKOFF_START_MS;
    const updates = result.result ?? [];

    for (const update of updates) {
      try {
        await handleUpdate(update, sender, username);
      } catch (err) {
        // One malformed update must not stall the loop or, worse, prevent the
        // offset advancing — which would replay it on every poll forever.
        console.error('[TgBot] Update handler threw:', (err as Error)?.message ?? err);
      }
    }

    offset = nextOffset(updates, offset);
  }
}

/** Route and execute one update. Reads the allowlist fresh so it can be changed
 *  by a restart-free env update on hosts that support it. */
async function handleUpdate(
  update: Parameters<typeof classifyUpdate>[0],
  sender: TelegramSender,
  username: string,
): Promise<void> {
  const decision = classifyUpdate(update, { botUsername: username, allowlist: readAllowedChatIds() });

  if (decision.kind === 'ignore') return;

  if (decision.kind === 'decline') {
    // One short line, high priority, no roster write: a chat outside the
    // allowlist never becomes a tenant.
    await sender.send(decision.chatId, DECLINE_MESSAGE, { priority: 'high' });
    return;
  }

  const command = commandMap.get(decision.command.name);
  // An unknown command is silence in a group — answering "unknown command" to
  // every /roll and /kick from some other bot is exactly the noise the privacy
  // promise is about. A DM gets the help hint, since there it is a real reply.
  if (!command) {
    if (decision.chat.type === 'private') {
      const help = commandMap.get('help');
      if (help) {
        await help.execute({
          chatId: decision.chatId,
          chat: decision.chat,
          from: decision.from,
          command: decision.command,
          reply: (text) => sender.send(decision.chatId, text, { priority: 'high' }),
        });
      }
    }
    return;
  }

  await command.execute({
    chatId: decision.chatId,
    chat: decision.chat,
    from: decision.from,
    command: decision.command,
    reply: (text) => sender.send(decision.chatId, text, { priority: 'high' }),
  });
}

/**
 * Start the digest flush.
 *
 * This is the timer that turns N buffered events into ONE message per chat, so
 * it is the difference between a summary and the flood. `unref` keeps it from
 * holding the process open at shutdown — the backend's exit must not wait out a
 * ten-minute interval — and the flush itself no-ops when there is no sender or
 * nothing buffered.
 */
function startDigestTimer(): void {
  if (digestTimer) return;
  const intervalMs = readDigestIntervalMs();
  digestTimer = setInterval(() => {
    void getAlertRouter()
      .flush()
      .catch((err) => console.error('[TgBot] Digest flush threw:', (err as Error)?.message ?? err));
  }, intervalMs);
  digestTimer.unref();
  console.log(`[TgBot] Alert digests flush every ${Math.round(intervalMs / 60_000)} min.`);
}

function stopDigestTimer(): void {
  if (!digestTimer) return;
  clearInterval(digestTimer);
  digestTimer = null;
}

/** Abort-aware sleep, so shutdown does not wait out a 60s backoff. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Stop the bot: cancel the in-flight long poll, drop the queue, wait for the
 * loop to exit. Safe to call when it never started.
 */
export async function stopTelegramBot(): Promise<void> {
  const current = state;
  const abort = lifetime;
  state = null;
  lifetime = null;
  // The router itself is kept: its guard windows are the flood protection, and
  // a restart handing every chat a fresh hourly budget is the wrong direction.
  stopDigestTimer();

  try {
    // Aborted first and unconditionally: a boot still in flight watches this
    // signal and gives up rather than coming back as an orphan poll loop.
    abort?.abort();
    current?.sender.stop();
    await current?.loop;
  } catch (err) {
    console.error('[TgBot] Error during shutdown:', (err as Error)?.message ?? err);
  }
}
