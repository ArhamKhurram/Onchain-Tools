// `/filters` — the bound account's market-cap thresholds, from Telegram.
//
// THE SAME KNOBS AS THE CONSOLE, AND LITERALLY THE SAME VALIDATOR. Every bound,
// direction, unit and label is read out of `mcapCross/filters.ts` at call time
// (through filtersView.ts), and every write goes through `validateFilterPatch`
// and `applyFilterPatch` — the two functions `PUT /api/mcap-cross/filters`
// calls. A threshold that means one thing in the console and another in
// Telegram is worse than no bot controls at all, so there is no second copy of
// a rule here to drift.
//
// THE FIELD LIST IS NOT WRITTEN DOWN ANYWHERE IN THIS FILE. It iterates
// `MCAP_CROSS_FILTER_KEYS`; a filter added to that table gains a row in the
// listing, a name the parser accepts, and a line in the usage text, with no
// edit here.
//
// IT NEEDS A LINKED CHAT, AND SAYS SO. These are one ACCOUNT's settings. A chat
// riding the instance default has no account of its own — editing there would
// silently retune the operator's own alerts from whatever room the bot happens
// to be in. So the requirement is an explicit `source_user_id`, and the refusal
// names the fix rather than doing nothing.
//
// AND IT IS ADMIN-GATED IN A GROUP, through the same `ctx.authorizeWrite` every
// other write uses. That gate is why linking a GROUP is itself an admin
// decision: its admins inherit the ability to change the linked account's
// alerts everywhere, not only in that room.

import { getChatStore } from '../chatStore.js';
import { SPEC } from '../commandCatalog.js';
import {
  readAccountFilters,
  resetAccountFilters,
  writeAccountFilter,
} from '../filterAccess.js';
import {
  asFilterKey,
  filterLabel,
  formatFilterValue,
  parseFilterValue,
  MCAP_CROSS_FILTER_KEYS,
} from '../filtersView.js';
import { bold, code, escapeHtml, italic, joinLines } from '../html.js';
import { accountFingerprint } from '../identity.js';
import { footer } from '../render.js';
import type { TgCommand, TgCommandContext } from './types.js';

/** The names the command accepts, rendered for a person. Table-driven. */
function nameList(): string {
  return MCAP_CROSS_FILTER_KEYS.map((key) => `${code(key)} — ${escapeHtml(filterLabel(key))}`).join(
    '\n',
  );
}

function usage(problem: string | null): string {
  return joinLines([
    problem ? `${bold('⚠️')} ${escapeHtml(problem)}` : bold('🎚 Alert filters'),
    '',
    `${code('/filters')} — show them`,
    `${code('/filters <name> <value>')} — set one`,
    `${code('/filters <name> inherit')} — clear one`,
    `${code('/filters reset')} — clear all of them`,
    '',
    bold('Names'),
    nameList(),
    '',
    italic(
      'Rates take a percentage with a % sign, or the fraction itself. Dollar amounts take a plain number.',
    ),
    footer(),
  ]);
}

/**
 * The account whose filters this chat may edit, or a refusal to send.
 *
 * Explicitly `record.sourceUserId` and NOT `resolveAlertSource` — see the
 * header. Falling back to the instance default here would turn every
 * unconfigured chat into a remote control for the operator's account.
 */
async function boundAccount(
  ctx: TgCommandContext,
): Promise<{ userId: string } | { refusal: string }> {
  const record = await getChatStore().get(ctx.chatId);
  if (!record) {
    return { refusal: 'This chat is not registered yet. Run /start first.' };
  }
  if (!record.sourceUserId) {
    return {
      refusal:
        'These are an OCT account’s own thresholds, and this chat is not linked to one yet. Generate a link code in the OCT console and run /link <code> here.',
    };
  }
  return { userId: record.sourceUserId };
}

function renderList(
  label: string,
  lines: ReturnType<typeof formatList>,
  overrideCount: number,
): string {
  return joinLines([
    bold('🎚 Alert filters'),
    italic(`For OCT account ${label}. The console shows the same values.`),
    '',
    ...lines,
    '',
    italic(
      overrideCount === 0
        ? 'Nothing is overridden — every threshold is the shipped default.'
        : `${overrideCount} threshold${overrideCount === 1 ? '' : 's'} overridden.`,
    ),
    `Change one with ${code('/filters <name> <value>')}.`,
    footer(),
  ]);
}

function formatList(lines: { label: string; value: string; overridden: boolean; inherited: string }[]): string[] {
  return lines.map((line) =>
    joinLines([
      `${bold(`${line.label}:`)} ${escapeHtml(line.value)}`,
      italic(line.overridden ? 'set by you' : `inherited (${line.inherited})`),
    ]),
  );
}

async function run(ctx: TgCommandContext): Promise<void> {
  const account = await boundAccount(ctx);
  if ('refusal' in account) {
    await ctx.reply(joinLines([escapeHtml(account.refusal), footer()]));
    return;
  }
  const label = accountFingerprint(account.userId) ?? 'an OCT account';
  const args = ctx.command.args;

  // Read: open to anyone who can see the chat, like every other read.
  if (args.length === 0) {
    // Cached, not fresh: a fifteen-second-old threshold is still the right
    // answer, and this is a read anyone in the chat can repeat at will.
    const view = await readAccountFilters(account.userId);
    if (!view) {
      await ctx.reply(
        joinLines([escapeHtml('OCT storage is unavailable — cannot read the filters.'), footer()]),
      );
      return;
    }
    await ctx.reply(renderList(label, formatList(view.lines), view.overrideCount));
    return;
  }

  const first = args[0]?.toLowerCase() ?? '';
  if (first === 'help' || first === 'usage') {
    await ctx.reply(usage(null));
    return;
  }

  // Everything past this point writes.
  const authorized = await ctx.authorizeWrite();
  if (!authorized.allow) {
    await ctx.reply(joinLines([escapeHtml(authorized.message), footer()]));
    return;
  }

  if (first === 'reset') {
    const result = await resetAccountFilters(account.userId);
    await ctx.reply(
      result.ok
        ? renderList(label, formatList(result.view.lines), result.view.overrideCount)
        : joinLines([escapeHtml(result.errors.join('; ')), footer()]),
    );
    return;
  }

  const key = asFilterKey(args[0]);
  if (!key) {
    await ctx.reply(usage(`There is no filter called "${args[0] ?? ''}".`));
    return;
  }

  const rest = args.slice(1).join(' ');
  if (rest.trim() === '') {
    await ctx.reply(usage(`Give a value for ${key}, or "inherit" to clear it.`));
    return;
  }

  const parsed = parseFilterValue(key, rest);
  if (!parsed.ok) {
    // The validator's own sentences, verbatim — the same ones the console's
    // 400 carries. Rewording them here is how the two surfaces start to
    // disagree about what a bound is.
    await ctx.reply(usage(parsed.errors.join('; ')));
    return;
  }

  const result = await writeAccountFilter(account.userId, key, parsed.value);
  if (!result.ok) {
    await ctx.reply(joinLines([escapeHtml(result.errors.join('; ')), footer()]));
    return;
  }

  await ctx.reply(
    joinLines([
      `${bold(`${escapeHtml(filterLabel(key))}:`)} ${escapeHtml(
        parsed.value === null ? 'back to the default' : formatFilterValue(key, parsed.value),
      )}`,
      italic(`Saved on OCT account ${label} — this changes its alerts everywhere, not just here.`),
      footer(),
    ]),
  );
}

export const filters: TgCommand = {
  name: SPEC.filters.name,
  description: SPEC.filters.description,
  execute: run,
};
