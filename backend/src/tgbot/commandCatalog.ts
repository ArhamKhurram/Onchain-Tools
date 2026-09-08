// What the bot's commands ARE, as data: one entry per command, grouped by the
// question a person is trying to answer.
//
// WHY A CATALOG AND NOT PROSE IN THE HELP CARD. Three surfaces have to agree
// about the command list — the `/help` card (render.ts), the panel's Help view
// (panel.ts) and Telegram's own `/` autocomplete menu (setMyCommands, wired in
// index.ts). They shipped as three hand-written lists, and they had already
// drifted: the panel's list omitted /start's parenthetical and neither list
// could ever include a command added later without somebody remembering. One
// table, three readers, no drift.
//
// WHY THE CATALOG AND NOT THE HANDLER REGISTRY IS THE SOURCE. commands/index.ts
// imports every handler, and those pull in the enrichment catalog, the FOMO
// client and Supabase. This file imports NOTHING, so the help text, the menu
// payload and the Telegram name/length rules are all unit-testable without
// standing up half the backend. Each handler reads its own `name` and
// `description` back out of here, so a handler and its menu entry cannot
// disagree; index.ts logs at boot if a catalog entry has no handler.
//
// GROUPING IS BY INTENT, NOT BY SUBSYSTEM. "Alerts" is where somebody goes when
// the bot is too loud or too quiet; "Look up" is where they go when they want a
// number. A flat alphabetical list is the shape that made /help unreadable —
// eight commands with nothing saying which one answers the question in hand.
//
// ADMIN-ONLY IS MARKED, NOT HIDDEN. A member of a group who reads /help should
// learn that /mute exists and that an admin has to run it, rather than run it
// and be refused. The marking here is presentation; the ENFORCEMENT is
// permissions.ts, called by the handlers that write.

/** One command, as every surface needs to describe it. */
export interface CommandSpec {
  /** Lowercase, no slash. Must satisfy Telegram's menu rule — see TELEGRAM_COMMAND_NAME. */
  name: string;
  /** One line for Telegram's `/` menu. ≤256 chars, no markup, no leading slash. */
  description: string;
  /** How it is typed, including arguments. Rendered as `<code>` in help. */
  usage: string;
  /** The half-sentence after the em dash in the help card. */
  blurb: string;
  /**
   * Does invoking this command in a way that CHANGES the chat require group
   * admin? True for anything that retunes what the whole room receives.
   * `/alerts` is marked because its `on`/`off` forms write; its bare read form
   * is open to any member, which is a per-invocation decision the handler makes
   * (see permissions.ts) rather than something this flag can express.
   */
  adminOnly: boolean;
}

/** A block of the help card. */
export interface CommandGroup {
  /** The heading, phrased as the thing the reader is trying to do. */
  title: string;
  /** Shown under the heading when the group needs a caveat. Null for none. */
  note: string | null;
  commands: readonly CommandSpec[];
}

const start: CommandSpec = {
  name: 'start',
  description: 'Open the OCT control panel for this chat',
  usage: '/start',
  blurb: 'open the control panel (subscribes to nothing)',
  adminOnly: false,
};

const help: CommandSpec = {
  name: 'help',
  description: 'Show the OCT bot command list',
  usage: '/help',
  blurb: 'this list',
  adminOnly: false,
};

const status: CommandSpec = {
  name: 'status',
  description: 'Show what this chat is registered for',
  usage: '/status',
  blurb: 'registration, subscriptions and whether anything is wired up',
  adminOnly: false,
};

const alerts: CommandSpec = {
  name: 'alerts',
  description: 'See and change what alerts this chat receives',
  usage: '/alerts [on|off <type>]',
  blurb: 'see what lands here, and turn a class on or off',
  adminOnly: true,
};

const mute: CommandSpec = {
  name: 'mute',
  description: 'Pause every alert in this chat for a while',
  usage: '/mute [30m|2h|1d]',
  blurb: 'pause every alert here without losing the subscriptions',
  adminOnly: true,
};

const unmute: CommandSpec = {
  name: 'unmute',
  description: 'Resume alerts in this chat',
  usage: '/unmute',
  blurb: 'resume them, including after an automatic mute',
  adminOnly: true,
};

/**
 * Binding a chat to an OCT account.
 *
 * `adminOnly` is TRUE because in a group it is the largest write the bot has:
 * it decides whose private alert feed the whole room reads, and it hands the
 * room's admins the linked account's filter controls. The enforcement is
 * `decideChatWrite`, like every other write.
 */
const link: CommandSpec = {
  name: 'link',
  description: 'Link this chat to an OCT account with a console code',
  usage: '/link <code>',
  blurb: 'bind this chat to your OCT account using a code from the console',
  adminOnly: true,
};

const unlink: CommandSpec = {
  name: 'unlink',
  description: 'Unbind this chat from its OCT account',
  usage: '/unlink [confirm]',
  blurb: 'undo the link; the chat falls back to the instance default',
  adminOnly: true,
};

const filters: CommandSpec = {
  name: 'filters',
  description: 'See and change the market-cap alert thresholds',
  usage: '/filters [<name> <value>|reset]',
  blurb: 'the linked account’s market-cap filters, the same ones the console shows',
  adminOnly: true,
};

const token: CommandSpec = {
  name: 'token',
  description: 'Market snapshot for a token address',
  usage: '/token <address> [chain]',
  blurb: 'market cap, price and liquidity from OCT enrichment',
  adminOnly: false,
};

const mcap: CommandSpec = {
  name: 'mcap',
  description: 'The most recent market-cap crossings',
  usage: '/mcap',
  blurb: 'the last coins to cross the market-cap threshold, scam-filtered',
  adminOnly: false,
};

const queued: CommandSpec = {
  name: 'queued',
  description: 'What the next digest will contain',
  usage: '/queued',
  blurb: 'what is buffered for this chat right now',
  adminOnly: false,
};

/**
 * `adminOnly` is FALSE and that is not an oversight. The marking describes the
 * group-admin rule, and this command has no group form at all: it is refused
 * outright outside a private chat, and inside one it needs a named operator
 * (sniperAccess.ts). "Admin can run it" would be a more permissive claim than
 * the truth, so the caveat goes on the group's note instead.
 */
const fees: CommandSpec = {
  name: 'fees',
  description: 'Show or set the sniper tip and priority fee',
  usage: '/fees [tip|priority <amount>]',
  blurb: 'the account tip and priority fee every rule inherits',
  adminOnly: false,
};

/**
 * `adminOnly` is FALSE for the same reason `/fees` is: this has no group form.
 * `/flap test` is refused outside a private chat and, inside one, needs a named
 * operator (the same TG_BOT_SNIPER_OPERATORS allowlist), so "a group admin can
 * run it" would overstate the access. The caveat lives on the group's note.
 */
const flap: CommandSpec = {
  name: 'flap',
  description: 'Admin: preview the most recent Flap stock listing',
  usage: '/flap test',
  blurb: 'operator dry-run — send yourself the latest Flap new-stock card',
  adminOnly: false,
};

/**
 * The help card, in reading order.
 *
 * "Set up" first because a chat that has just added the bot is the common
 * reader; "Alerts" second because too-loud and too-quiet are the two questions
 * that bring anyone back; lookups last because they are the ones you already
 * know you want.
 */
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  { title: 'Set up', note: null, commands: [start, status, help] },
  {
    title: 'Your OCT account',
    note: 'Linking decides whose alerts arrive here. In a group, only an admin can.',
    commands: [link, unlink, filters],
  },
  {
    title: 'Alerts',
    note: 'In a group, only an admin can change these.',
    commands: [alerts, mute, unmute],
  },
  { title: 'Look up', note: null, commands: [token, mcap, queued] },
  {
    title: 'Sniper',
    note: 'Private chat only, and only for an authorized operator.',
    commands: [fees],
  },
  {
    title: 'Diagnostics',
    note: 'Private chat only, and only for an authorized operator.',
    commands: [flap],
  },
];

/** Every spec, in help order. The menu and the boot-time coverage check read this. */
export const COMMAND_SPECS: readonly CommandSpec[] = COMMAND_GROUPS.flatMap((g) => [...g.commands]);

/**
 * The specs, keyed, for handlers: `SPEC.token.description`.
 *
 * A frozen record rather than a lookup call so a typo is a compile error in the
 * handler rather than a null at boot.
 */
export const SPEC = {
  start,
  help,
  status,
  alerts,
  mute,
  unmute,
  token,
  mcap,
  queued,
  fees,
  flap,
  link,
  unlink,
  filters,
} as const;

// --- Telegram's `/` menu -----------------------------------------------------

/**
 * Telegram's rule for a menu command name: 1-32 characters, lowercase Latin
 * letters, digits and underscores only. A payload that breaks it is a 400 on
 * setMyCommands, which fails the WHOLE list — so one bad entry would cost the
 * menu entirely, and the builder below drops it instead.
 */
export const TELEGRAM_COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

/** Telegram's cap on a menu description. Long ones are truncated, not dropped. */
export const MAX_MENU_DESCRIPTION = 256;

/** One entry of a setMyCommands payload. */
export interface TgMenuCommand {
  command: string;
  description: string;
}

/**
 * Build the setMyCommands payload.
 *
 * PURE, AND IT DROPS RATHER THAN THROWS. This runs at boot inside the bot's
 * "never take the backend down" contract, and the whole call is best-effort:
 * an unusable entry costs that one entry, never the menu and never the process.
 * `onProblem` lets index.ts log what was dropped without this function knowing
 * about the console.
 */
export function telegramCommandMenu(
  specs: readonly CommandSpec[] = COMMAND_SPECS,
  onProblem?: (problem: string) => void,
): TgMenuCommand[] {
  const out: TgMenuCommand[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    if (!TELEGRAM_COMMAND_NAME.test(spec.name)) {
      onProblem?.(`command name ${JSON.stringify(spec.name)} is not menu-legal`);
      continue;
    }
    if (seen.has(spec.name)) {
      onProblem?.(`command name ${JSON.stringify(spec.name)} is listed twice`);
      continue;
    }
    const description = spec.description.trim();
    if (description === '') {
      onProblem?.(`command ${JSON.stringify(spec.name)} has no description`);
      continue;
    }
    seen.add(spec.name);
    out.push({ command: spec.name, description: description.slice(0, MAX_MENU_DESCRIPTION) });
  }

  return out;
}
