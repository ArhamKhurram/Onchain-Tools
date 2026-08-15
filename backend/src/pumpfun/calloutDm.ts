// Private Discord DMs for pump.fun callouts — the operator's ask: "instead of a
// channel the bot can just send the alerts of people the user subscribes to in
// their DMs".
//
// This is the FOURTH delivery leg for a matched callout, and its position in the
// queue is deliberate:
//
//   1. WS frame        → the console (always)
//   2. Pushover push   → opt-in, per-caller (notify_pushover)
//   3. Discord DM      → opt-in, per-caller (notify_discord)   ← this module
//   4. Public channel  → operator-configured, follow-graph-blind (calloutDiscord.ts)
//
// Four properties are structural, not stylistic:
//
//  1. IT RUNS LAST AND CANNOT BREAK WHAT WORKS. The poller's dispatch loop
//     finishes every WS send and Pushover push BEFORE this is called, and the
//     entry point never rejects. A Discord outage must not cost anyone the
//     console ping they already had.
//
//  2. THREE GATES, ALL PER-USER. A DM requires (a) discordBotDm.enabled — the
//     master switch that governs every OCT bot DM, off by default; (b)
//     discordBotDm.triggers.pumpCallout — callouts as a DM-worthy class; and
//     (c) the follow row's notify_discord — the per-caller mute. A stored
//     config missing the trigger key reads as FALSE, so nobody starts getting
//     DMs from a deploy.
//
//  3. THE FOLLOW GRAPH STAYS PRIVATE. Unlike the public channel poster, this
//     one legitimately reads pump_tracked_callers — because each message goes
//     to exactly the one user who made that follow. Nothing here aggregates
//     across users, and no payload names anyone but the recipient.
//
//  4. IT IS PACED AND CAPPED. Discord restricts bots that burst unsolicited
//     DMs, and that restriction would take the ALERT DMs down with it. So sends
//     are sequential with a floor gap and one dispatch is capped; overflow is
//     dropped and counted (a stale callout DM'd two minutes late is noise), and
//     the drop is logged rather than hidden.

import type { Client } from 'discord.js';
import { buildContractUrl, type ContractLinkTemplates } from '@oct/shared';
import { getBotClient } from '../bot/index.js';
import { resolveDiscordIdByOctUser } from '../bot/identity.js';
import { sendBotDm, type DmOutcome } from '../bot/dm.js';
import { DM_INTERVAL_MS } from '../bot/releaseNotes.js';
import {
  BRAND,
  botFooter,
  compactUsd,
  makeContainer,
  makeSection,
  makeSeparator,
  makeText,
  makeThumbnail,
  quoteLines,
  shortAddress,
} from '../bot/layout.js';
import { getStorageProvider } from '../storage/index.js';

/**
 * Most DMs one dispatch may send. A pump burst can put dozens of callouts in a
 * single 12s poll; at the floor gap that would keep the poller busy past its own
 * interval. Cap, drop the overflow, and say so in the log.
 */
export const MAX_DMS_PER_DISPATCH =
  Number.parseInt(process.env.PUMP_CALLOUT_DM_MAX_PER_DISPATCH ?? '', 10) || 12;

const THESIS_LIMIT = 400;

/** Same trade-link convention the public callout card uses. */
const LINK_TEMPLATES: ContractLinkTemplates = {
  evm: 'https://gmgn.ai/base/token/{address}',
  sol: 'https://axiom.trade/t/{address}?chain=sol',
  solPlatform: 'axiom',
  evmPlatform: 'gmgn',
};

// ---------------------------------------------------------------------------
// Opt-in gating (pure)
// ---------------------------------------------------------------------------

/**
 * Do this user's SETTINGS permit a callout DM? Both the master switch and the
 * pumpCallout trigger must be explicitly true.
 *
 * Written defensively against an untyped `settings` blob, and fail-closed on a
 * missing key — exactly like isReleaseNotesOptIn / isDailyDigestOptIn. That is
 * what keeps an existing account with bot DMs already on from silently
 * acquiring a new message class when this ships.
 */
export function isCalloutDmOptIn(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false;
  const dm = (settings as Record<string, unknown>).discordBotDm;
  if (!dm || typeof dm !== 'object') return false;
  const prefs = dm as { enabled?: unknown; triggers?: unknown };
  if (prefs.enabled !== true) return false;
  if (!prefs.triggers || typeof prefs.triggers !== 'object') return false;
  return (prefs.triggers as Record<string, unknown>).pumpCallout === true;
}

/**
 * The full three-gate decision for one (follower, caller) pair.
 *
 * `notifyDiscord` is the per-caller mute carried on the follow row; it is
 * checked FIRST because it is the cheap, local half of the decision.
 */
export function shouldDmCallout(notifyDiscord: boolean, settings: unknown): boolean {
  if (!notifyDiscord) return false;
  return isCalloutDmOptIn(settings);
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

export interface CalloutDmInput {
  callerAddress: string;
  callerName: string | null;
  callerAvatar: string | null;
  mint: string;
  symbol: string | null;
  coinName: string | null;
  thesis: string | null;
  marketCapUsd: number | null;
  multiple: number | null;
}

/** `papipablo` / `7xK1..pump` — who made the call. */
export function callerLabel(input: Pick<CalloutDmInput, 'callerName' | 'callerAddress'>): string {
  const name = input.callerName?.trim();
  return name ? `@${name.replace(/^@/, '')}` : shortAddress(input.callerAddress);
}

/** `$TOAD` / the short mint when the coin has no ticker yet. */
export function coinLabel(input: Pick<CalloutDmInput, 'symbol' | 'mint'>): string {
  const symbol = input.symbol?.trim();
  return symbol ? `$${symbol.replace(/^\$/, '')}` : shortAddress(input.mint);
}

/**
 * Render one callout as a branded Components V2 DM.
 *
 * Same gold accent and same anatomy as the public channel card
 * (calloutDiscord.ts) so a user who has seen one recognises the other — caller
 * headline with avatar, MC at the moment of the call, the thesis verbatim, the
 * mint in a tap-to-copy fence, chart + pump.fun links. The footer differs: this
 * one says WHY you got it and where to turn it off, because it is a personal DM.
 */
export function buildCalloutDmComponents(input: CalloutDmInput): unknown[] {
  const caller = callerLabel(input);
  const coin = coinLabel(input);

  const meta: string[] = [`MC at call ${input.marketCapUsd != null ? compactUsd(input.marketCapUsd) : '—'}`];
  if (input.multiple != null && input.multiple >= 1.05) meta.push(`${input.multiple.toFixed(2)}× since`);

  const headline = [makeText(`# 📣 ${caller} called ${coin}`), makeText(`-# ${meta.join(' · ')}`)];
  // A section floats the caller's avatar beside the headline; with no avatar
  // there is nothing to float, so the same lines go in bare.
  const header = input.callerAvatar ? [makeSection(headline, makeThumbnail(input.callerAvatar))] : headline;

  const thesis = input.thesis?.trim();
  const thesisBlock = thesis
    ? makeText(quoteLines(thesis.length > THESIS_LIMIT ? `${thesis.slice(0, THESIS_LIMIT - 1)}…` : thesis))
    : makeText('-# No thesis given.');

  const chartUrl = buildContractUrl(input.mint, LINK_TEMPLATES);
  const links = `[Chart →](${chartUrl}) · [pump.fun →](https://pump.fun/coin/${encodeURIComponent(input.mint)})`;

  const footer = input.coinName
    ? `${input.coinName} · you follow ${caller} · manage in OCT → Pump.fun → Following`
    : `You follow ${caller} · manage in OCT → Pump.fun → Following`;

  return [
    makeContainer(BRAND.gold, [
      ...header,
      makeSeparator(1),
      thesisBlock,
      makeText(`\`\`\`\n${input.mint}\n\`\`\``),
      makeText(links),
      makeText(botFooter(footer)),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** One queued DM: who to send to, and what the card says. */
export interface CalloutDmJob {
  userId: string;
  /** The follow row's per-caller mute for this pair. */
  notifyDiscord: boolean;
  callout: CalloutDmInput;
}

export interface CalloutDmResult {
  /** Jobs whose three gates all passed and that fit under the dispatch cap. */
  eligible: number;
  delivered: number;
  /** Users Discord won't let us DM (closed DMs / no shared server). Not a failure. */
  blocked: number;
  failed: number;
  /** Eligible jobs dropped because the dispatch cap was hit. */
  dropped: number;
}

/** Seams for tests; realDeps wires the live implementations. */
export interface CalloutDmDeps {
  getClient: () => Client | null;
  /** The user's OCT config, for the two settings gates. */
  loadSettings: (userId: string) => Promise<unknown>;
  resolveDiscordId: (octUserId: string) => Promise<string | null>;
  send: (client: Client, discordId: string, components: unknown[]) => Promise<{ outcome: DmOutcome }>;
  sleep: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const realDeps: CalloutDmDeps = {
  getClient: getBotClient,
  loadSettings: (userId) => getStorageProvider().getConfig(userId),
  resolveDiscordId: resolveDiscordIdByOctUser,
  send: sendBotDm,
  sleep,
};

/**
 * DM every eligible job. NEVER throws and never rejects — the poller awaits this
 * after its own delivery, and a Discord problem must not touch that path.
 *
 * Per-user lookups (settings + Discord id) are memoised for the call, so a burst
 * of ten callouts to one follower costs one config read, not ten.
 */
export async function deliverCalloutDms(
  jobs: CalloutDmJob[],
  deps: CalloutDmDeps = realDeps,
): Promise<CalloutDmResult> {
  const result: CalloutDmResult = { eligible: 0, delivered: 0, blocked: 0, failed: 0, dropped: 0 };
  try {
    if (jobs.length === 0) return result;
    const client = deps.getClient();
    if (!client) return result; // bot not connected on this instance

    // userId → the resolved recipient, or null when any gate failed. Cached so
    // the per-user work happens once per dispatch.
    const recipients = new Map<string, string | null>();
    // One warning per user per dispatch, never one per callout.
    const warned = new Set<string>();

    for (const job of jobs) {
      if (!job.notifyDiscord) continue;

      let discordId = recipients.get(job.userId);
      if (discordId === undefined) {
        discordId = null;
        try {
          const settings = await deps.loadSettings(job.userId);
          if (isCalloutDmOptIn(settings)) discordId = await deps.resolveDiscordId(job.userId);
        } catch (err) {
          console.warn('[PumpCalloutDm] Opt-in lookup failed for one user:', (err as Error)?.message ?? err);
        }
        recipients.set(job.userId, discordId);
      }
      if (!discordId) continue;

      result.eligible += 1;
      if (result.delivered + result.blocked + result.failed >= MAX_DMS_PER_DISPATCH) {
        result.dropped += 1;
        continue;
      }

      const { outcome } = await deps.send(client, discordId, buildCalloutDmComponents(job.callout));
      if (outcome === 'delivered') {
        result.delivered += 1;
      } else if (outcome === 'blocked') {
        result.blocked += 1;
        if (!warned.has(job.userId)) {
          warned.add(job.userId);
          console.warn(
            '[PumpCalloutDm] Cannot DM a follower — Discord requires that they share a server with the ' +
              'bot (or have DMs open). Ask them to join the OCT server.',
          );
        }
        // Nothing to retry and nothing left to pace against for this user.
        continue;
      } else {
        result.failed += 1;
      }
      await deps.sleep(DM_INTERVAL_MS);
    }

    if (result.dropped > 0) {
      console.warn(
        `[PumpCalloutDm] dispatch cap hit: ${result.dropped} callout DM(s) dropped ` +
          `(cap ${MAX_DMS_PER_DISPATCH}); sent ${result.delivered}.`,
      );
    }
  } catch (err) {
    console.warn('[PumpCalloutDm] unexpected failure:', (err as Error)?.message ?? String(err));
  }
  return result;
}
