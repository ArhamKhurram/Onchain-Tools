// `/fees` — the account-level tip and priority fee, from Telegram.
//
// WHAT IT IS NOT. It is not a spend path. `executeFire` is still the only
// function in OCT that can spend (CLAUDE.md), and nothing here calls it or
// anything downstream of it. This reads and writes two numbers on the same
// `SniperStore` methods `/sniper/v1/fees` uses, through the same validator.
//
// WHY WRITES ARE ALLOWED AT ALL, AND WHAT MAKES THEM SAFE. The tip is what the
// operator bids for blockspace, so a bad write costs money on every subsequent
// fire. Four things stand in front of it, and all four are in sniperAccess.ts
// rather than here, so the rule has one home:
//
//   private chat only  ·  the chat's own owner  ·  a named operator (env)
//                      ·  a resolved OCT account
//
// The env allowlist is the load-bearing one: UNSET MEANS NOBODY, so this
// command is inert on any deployment that has not deliberately opted in. A
// group — even a group of admins — is refused before anything else is checked.
//
// VALIDATION IS NOT REIMPLEMENTED HERE. `parseFeeComponent` is the same
// function `/sniper/v1/fees` calls, and the ceiling in the error text is read
// from `MAX_FEE_COMPONENT` rather than typed out, so raising or lowering the
// bound moves both surfaces and both messages at once.
//
// NOTHING SECRET IS ECHOED. Fee components are numbers the operator chose. No
// venue token, wallet id, session string or Supabase key is read by this file
// or reachable from what it prints.

import { MAX_FEE_COMPONENT, parseFeeComponent } from '../../sniper/fees.js';
import type { SniperFeeSettings } from '../../sniper/types.js';
import { getSniperRuntime } from '../../sniper/runtime.js';
import { getChatStore } from '../chatStore.js';
import { SPEC } from '../commandCatalog.js';
import { bold, escapeHtml, joinLines } from '../html.js';
import { footer } from '../render.js';
import { decideSniperAccessFromEnv } from '../sniperAccess.js';
import type { TgCommand, TgCommandContext } from './types.js';

/** The two components, and every spelling a person might reasonably type. */
const COMPONENT_ALIASES: Record<string, keyof SniperFeeSettings> = {
  tip: 'tip',
  priority: 'priorityFee',
  prio: 'priorityFee',
  priorityfee: 'priorityFee',
  priority_fee: 'priorityFee',
};

export type FeesCommand =
  | { kind: 'show' }
  | { kind: 'set'; component: keyof SniperFeeSettings; raw: string }
  | { kind: 'usage'; problem: string | null };

/**
 * Parse `/fees`, `/fees tip 0.001`, `/fees priority 0.0005`.
 *
 * Pure and exported so the grammar is testable without a store. It does NOT
 * validate the amount — `parseFeeComponent` owns the bounds, and a parser that
 * also range-checked would be the second copy this whole change removes.
 */
export function parseFeesCommand(args: readonly string[]): FeesCommand {
  const parts = args.filter((a) => a.trim() !== '');
  if (parts.length === 0) return { kind: 'show' };

  const component = COMPONENT_ALIASES[parts[0]!.toLowerCase()];
  if (!component) {
    return { kind: 'usage', problem: `Unknown setting "${parts[0]}".` };
  }
  if (parts.length === 1) {
    return { kind: 'usage', problem: 'Give an amount, in SOL.' };
  }
  if (parts.length > 2) {
    return { kind: 'usage', problem: 'One setting at a time, please.' };
  }
  return { kind: 'set', component, raw: parts[1]! };
}

/** The human name of a component, for confirmations and errors. */
function label(component: keyof SniperFeeSettings): string {
  return component === 'tip' ? 'Tip' : 'Priority fee';
}

/** Fee components are small; show enough decimals that 0.0005 is not "0". */
function amount(value: number): string {
  return `${Number(value.toFixed(9))} SOL`;
}

export function renderFees(fees: SniperFeeSettings): string {
  return joinLines([
    bold('⚙️ Sniper fees'),
    `${bold('Tip:')} ${escapeHtml(amount(fees.tip))}`,
    `${bold('Priority fee:')} ${escapeHtml(amount(fees.priorityFee))}`,
    '',
    escapeHtml('Account-level. A rule that sets its own value keeps it; every other rule inherits these.'),
    escapeHtml('Change one with /fees tip 0.001 or /fees priority 0.0005'),
    footer(),
  ]);
}

export function renderFeesUsage(problem: string | null): string {
  return joinLines([
    problem ? escapeHtml(problem) : null,
    bold('Usage'),
    escapeHtml('/fees — show the account tip and priority fee'),
    escapeHtml('/fees tip <amount> — set the tip, in SOL'),
    escapeHtml('/fees priority <amount> — set the priority fee, in SOL'),
    '',
    escapeHtml(`Each must be a number between 0 and ${MAX_FEE_COMPONENT}.`),
    footer(),
  ]);
}

/** One refusal or error, in the shape every other command replies with. */
async function say(ctx: TgCommandContext, text: string): Promise<void> {
  await ctx.reply(joinLines([escapeHtml(text), footer()]));
}

export const fees: TgCommand = {
  name: SPEC.fees.name,
  description: SPEC.fees.description,

  async execute(ctx) {
    const parsed = parseFeesCommand(ctx.command.args);
    if (parsed.kind === 'usage') {
      await ctx.reply(renderFeesUsage(parsed.problem));
      return;
    }

    if (!ctx.from) {
      // No sender means no one to authorize. Channel posts land here; the
      // router already drops most of them, and this is the safe end of the rest.
      await say(ctx, 'Sniper settings need a signed-in Telegram sender.');
      return;
    }

    // Same reasoning as /alerts and /mute: a chat that is not a tenant has no
    // state to act on, and registering it as a side effect would be the
    // fail-open mistake in a new place.
    const record = await getChatStore().get(ctx.chatId);
    if (!record) {
      await say(ctx, 'This chat is not registered yet. Run /start first.');
      return;
    }

    // `isAdmin: false` is not a shortcut — a non-private chat is refused by the
    // FIRST condition in decideSniperAccess, before the chat-write rule is
    // consulted, so no group verdict can ever be needed here. Passing false
    // keeps the fail-closed direction if that order were ever changed, and
    // costs no getChatMember round trip on the path that is allowed.
    const access = decideSniperAccessFromEnv(
      {
        chatId: ctx.chatId,
        chatType: ctx.chat.type,
        userId: ctx.from.id,
        isAdmin: false,
      },
      record,
    );
    if (!access.allow) {
      await say(ctx, access.message);
      return;
    }

    const { store } = getSniperRuntime();

    try {
      const current = await store.getFeeSettings(access.userId);

      if (parsed.kind === 'show') {
        await ctx.reply(renderFees(current));
        return;
      }

      // The SAME validator the HTTP boundary uses. A refusal is a refusal, not
      // a coercion: storing a silently-zeroed tip would tell the operator their
      // change landed when it was discarded.
      const component: keyof SniperFeeSettings = parsed.component;
      const value = parseFeeComponent(parsed.raw, current[component]);
      if (value === null) {
        await say(
          ctx,
          `${label(parsed.component)} must be a number between 0 and ${MAX_FEE_COMPONENT}.`,
        );
        return;
      }

      const next: SniperFeeSettings = { ...current, [parsed.component]: value };
      await store.setFeeSettings(access.userId, next);
      // Read back rather than echoing what we sent: the store normalizes on
      // write, and the operator should see what is actually stored.
      await ctx.reply(renderFees(await store.getFeeSettings(access.userId)));
    } catch (err) {
      console.error('[TgBot] /fees failed:', (err as Error)?.message ?? err);
      await say(ctx, 'Could not reach OCT sniper storage right now. Try again in a minute.');
    }
  },
};
