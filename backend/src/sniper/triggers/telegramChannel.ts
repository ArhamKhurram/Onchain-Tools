// The Telegram trigger — one channel, EVM contract addresses, straight into the
// existing fire path.
//
// WHAT THIS ADAPTER IS ALLOWED TO DO: filter by chat id, pull EVM addresses out
// of the text, shape them for `fireRuleNow`. That is all. It performs NO risk
// check of its own — not the daily cap, not the kill switch, not idempotency —
// because every one of those already lives inside `executeFire`, and a control
// duplicated here would be a control that can drift out of step with the one
// that actually binds. `executeFire` remains the only function that spends and
// `fireRuleNow` remains its only caller (see CLAUDE.md, "Sniper").
//
// TWO SHAPE ADAPTATIONS are worth naming, because both are load-bearing:
//
//  1. The sniper's trigger type is `NormalizedTweet`. A Telegram post is not a
//     tweet, so `toTokenTrigger` below builds a synthetic one. Nothing about
//     that is cosmetic — see (2).
//
//  2. Dedupe is "never fire twice on the same TOKEN", not "never fire twice on
//     the same message". So the synthetic trigger's identity is the token
//     address, in BOTH fields the ledger keys on: `rootTweetId` (which
//     `triggerKey` returns) and `text` (which the content guard hashes). Putting
//     the message text in `text` instead would have been the obvious thing and
//     also a bug: two different addresses in one post hash identically, so the
//     content guard would suppress the second token as a duplicate of the first.
//     `IdempotencyLedger` is reused exactly as-is; only its input is adapted.
//
//     A consequence worth stating outright, because it will otherwise read as a
//     bug: the claim is taken in executeFire step 1, BEFORE the pre-trade gates
//     run, and it is never released. So a token rejected for thin liquidity at
//     10:00 is suppressed — not re-evaluated — when the channel re-posts it at
//     10:30 with a funded pool. That is the requirement ("never fire twice on
//     the same address") applied consistently, and it errs toward not spending.
//     Re-arming a token would mean releasing claims on abort, which is exactly
//     the shape that turns one post into repeated buy attempts.
//
// LOCAL MODE ONLY. The signing key is process-scoped, so in hosted mode any
// tenant whose Telegram session ingested a message would spend the operator's
// wallet. That is the same failure the `Venue` doc-comment in types.ts refuses
// for GMGN, and it is refused here for the same reason. Per-user EVM keys are a
// different feature, not a flag on this one.

import { detectContractAddresses, isEvmAddress } from '../../utils/contract.js';
import type { TelegramRawMessage } from '../../telegram/types.js';
import { estimateFees } from '../fees.js';
import { computeLegs } from '../legs.js';
import type { EvmSniperConfig } from '../evm/config.js';
import { fireRuleNow, type FireRuleNowParams } from '../fireOrchestrator.js';
import type { FireResult } from '../executeFire.js';
import { utcDay } from '../store.js';
import type { SniperStore } from '../storeInterface.js';
import type { NormalizedTweet, SnipeRule, WalletConfig } from '../types.js';
import { validateRuleStructure } from '../validateRule.js';

/**
 * The single wallet row the EVM sniper budgets against.
 *
 * A constant, not operator input: there is exactly one signing key per process,
 * so there is exactly one budget. A configurable id would let two rules point at
 * two rows and give the same wallet two independent daily caps.
 */
export const EVM_WALLET_ID = 'evm-rhc-env-key';

/** The rule id every synthetic trigger carries. The ledger's claims are keyed on it. */
export const EVM_RULE_ID = 'evm-telegram-trigger';

export interface EvmTriggerDeps {
  userId: string;
  config: EvmSniperConfig;
  store: SniperStore;
  /** Injected so tests can assert the fire path without reaching executeFire. */
  fire?: (params: FireRuleNowParams) => Promise<FireResult>;
  /** Injected clock (ms). */
  now?: () => number;
  /** Injected detector; defaults to the shared one the ingest pipeline uses. */
  detect?: (text: string) => string[];
}

// ---------------------------------------------------------------------------
// The synthetic rule
// ---------------------------------------------------------------------------

/**
 * Build the rule for one token.
 *
 * Constructed per fire rather than persisted, because `executeFire` takes the
 * rule as a parameter and never reads it back from the store — the only row that
 * MUST exist is the wallet, which is what the budget hangs off. Keeping the rule
 * out of the store also means an operator cannot arm, re-size or re-point it
 * through the console behind the env's back: this rule is exactly what the
 * environment says it is, every time.
 *
 * `autoDisableAfterFire` is false on purpose. It is the right default for a
 * hand-fired tweet rule, and the wrong one here — the daily cap is what stops
 * this trigger, and self-disabling after the first fire would silently reduce
 * the module to one buy per restart.
 */
export function buildEvmRule(userId: string, token: string, config: EvmSniperConfig): SnipeRule {
  const draft: SnipeRule = {
    id: EVM_RULE_ID,
    userId,
    name: 'EVM Telegram trigger',
    state: 'armed',
    chain: 'rhc',
    venue: 'evm_uniswap',
    // Twitter-shaped fields the Telegram path does not use. The matcher is never
    // consulted — this trigger's condition is "the allowlisted channel posted an
    // EVM address", which the adapter checks directly — but the field is
    // required and must still be structurally valid.
    handles: [],
    interactionTypes: ['tweet'],
    matcher: { op: 'leaf', pattern: { pattern: token, matchMode: 'includes' } },

    phase: 1,
    mint: token,
    entryStyle: 'single',
    ladderSplit: null,

    sizeUnit: 'ETH',
    sizeTotal: config.buyEth,
    walletIds: [EVM_WALLET_ID],

    // Placeholders; replaced below with the exact figure executeFire computes.
    perFireCap: config.buyEth,
    perTriggerCap: config.buyEth,

    slippageBps: config.slippageBps,
    exec: { kind: 'evm', mevRelay: null },

    // Inert here (there is no tweet clock), but must be a valid positive int.
    maxTweetAgeMs: 60_000,
    fireWindowMs: 30_000,
    maxAttempts: 2,
    mcapCeiling: null,
    autoDisableAfterFire: false,
    // The per-rule flag. `OCT_SNIPER_DRY_RUN` still overrides it process-wide,
    // which is how an operator dry-runs this trigger end to end with no key.
    dryRun: false,
  };

  // The caps are derived through the SAME functions executeFire uses, rather
  // than by retyping `buyEth * 1.01` here. `amountWithFees` is compared against
  // these caps with `>`, so a cap computed even one float ULP low would abort
  // every single fire with `per_fire_cap` — a failure that looks exactly like a
  // working cap doing its job.
  const legs = computeLegs(draft);
  const perLeg = legs.reduce((max, leg) => Math.max(max, leg.amount + estimateFees(draft, leg.amount)), 0);
  draft.perFireCap = perLeg;
  draft.perTriggerCap = perLeg;
  return draft;
}

/**
 * The wallet row the daily cap lives on.
 *
 * THIS is where `SNIPER_EVM_DAILY_CAP_ETH` becomes enforceable. The cap is not
 * re-implemented in this module — it is written onto the budget row that
 * `store.reserveLeg` already debits atomically inside `executeFire`, so it
 * resets on the UTC day boundary and is contended correctly by the hosted store,
 * for free, with no second code path to keep honest.
 *
 * `address` is the operator's declared wallet when they set one, and empty
 * otherwise. Unlike Slotshark's, this field is NOT used to route funds anywhere:
 * the EVM executor derives its address from the key at fire time. It is a label,
 * and the real "is this the wallet you meant?" check is the key-vs-declaration
 * comparison inside the executor.
 */
export function buildEvmWallet(config: EvmSniperConfig, perFireCap: number): WalletConfig {
  // maxOpen is sized so it can never bind BEFORE the daily cap does. Nothing on
  // the EVM path closes a position (a real fill has no balance poll behind it),
  // so a smaller value would degenerate into a second, quieter daily limit that
  // stops the sniper for a reason the operator never configured. The daily cap
  // is the governing control and this makes sure it is the one that speaks.
  const firesPerDay = Math.max(1, Math.ceil(config.dailyCapEth / Math.max(perFireCap, Number.EPSILON)));
  return {
    walletId: EVM_WALLET_ID,
    label: 'Robinhood Chain (env signing key)',
    venue: 'evm_uniswap',
    address: config.declaredWalletAddress ?? '',
    chain: 'rhc',
    unit: 'ETH',
    perFireCap,
    dailyCap: config.dailyCapEth,
    maxOpen: firesPerDay + 1,
  };
}

/**
 * Create (or re-sync) the budget wallet.
 *
 * `clampBudgetCaps` afterwards is what makes "lower the cap, restart" take
 * effect today rather than tomorrow. Caps are snapshotted onto the day's budget
 * row when it is created — deliberately, so a mid-day RAISE cannot retroactively
 * re-authorise a fire that was already refused — but that same rule would make a
 * mid-day REDUCTION do nothing, and a reduction is the operator's most likely
 * risk-lowering action. `clampBudgetCaps` is monotonic-down, so this only ever
 * tightens.
 */
export async function ensureEvmWallet(
  store: SniperStore,
  userId: string,
  config: EvmSniperConfig,
  day: string,
): Promise<WalletConfig> {
  const perFireCap = buildEvmRule(userId, '0x0000000000000000000000000000000000000000', config).perFireCap;
  const wallet = buildEvmWallet(config, perFireCap);
  await store.putWallet(userId, wallet);
  await store.clampBudgetCaps(userId, {
    walletId: wallet.walletId,
    chain: wallet.chain,
    day,
    perFireCap: wallet.perFireCap,
    dailyCap: wallet.dailyCap,
    maxOpen: wallet.maxOpen,
  });
  return wallet;
}

// ---------------------------------------------------------------------------
// Message -> trigger
// ---------------------------------------------------------------------------

/**
 * Is this message from a channel the operator armed?
 *
 * `TelegramRawMessage.chatId` is the bare Bot-API id (`-100…`); the composite
 * `chatId:topicId` form only appears downstream on `FrontendMessage.channelId`.
 * Matching the bare id therefore covers every topic of a forum group, which is
 * the behaviour an operator listing one channel expects.
 *
 * An empty allowlist matches NOTHING. That is the fail-closed default and the
 * reason this is not shared with `tgbot/access.ts`, whose empty case means
 * "serve everyone".
 */
export function isTriggerChat(chatId: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(chatId.trim());
}

/**
 * The synthetic trigger for one token. See the header for why every identity
 * field is the token address rather than anything about the message.
 */
export function toTokenTrigger(token: string, observedAt: number): NormalizedTweet {
  const key = token.toLowerCase();
  return {
    tweetId: key,
    rootTweetId: key,
    handle: 'telegram',
    interaction: 'tweet',
    text: key,
    createdAt: observedAt,
    firstSeenAt: observedAt,
  };
}

/**
 * Pull the EVM addresses out of a message.
 *
 * Reuses the ingest pipeline's own detector rather than a second regex, so the
 * sniper sees exactly the addresses the console sees — including its handling of
 * markdown links and its refusal to treat a checksummed EVM address as a
 * possible Solana mint. Non-EVM detections are dropped here: this executor only
 * speaks Robinhood Chain, and a Solana mint reaching it would resolve no route.
 *
 * Deduped in-message so a post that repeats an address does not queue two fires
 * before the ledger has claimed either.
 */
export function extractEvmTokens(text: string, detect = defaultDetect): string[] {
  const seen = new Set<string>();
  for (const addr of detect(text)) {
    if (!isEvmAddress(addr)) continue;
    seen.add(addr.toLowerCase());
  }
  return [...seen];
}

function defaultDetect(text: string): string[] {
  return detectContractAddresses(text).addresses;
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

/**
 * Build the Telegram listener, or return null when the trigger is not armed.
 *
 * Returning NULL rather than a no-op function is deliberate: the caller then has
 * nothing to register, so an unconfigured sniper is not merely inert, it is
 * absent from the event emitter entirely. There is no path from a Telegram
 * message to this module when `SNIPER_EVM_TRIGGER_CHAT_IDS` is unset.
 */
export function createTelegramEvmTrigger(
  deps: EvmTriggerDeps,
): ((raw: TelegramRawMessage) => Promise<void>) | null {
  const { userId, config, store } = deps;
  if (config.triggerChatIds.size === 0) return null;

  const fire = deps.fire ?? fireRuleNow;
  const now = deps.now ?? (() => Date.now());
  const detect = deps.detect ?? defaultDetect;

  return async (raw: TelegramRawMessage): Promise<void> => {
    if (!isTriggerChat(raw.chatId, config.triggerChatIds)) return;

    const tokens = extractEvmTokens(raw.text ?? '', detect);
    if (tokens.length === 0) return;

    for (const token of tokens) {
      const rule = buildEvmRule(userId, token, config);

      // Cheap, and it catches a misconfigured environment before any network
      // call: a size or slippage the env produced that could never arm through
      // the console must not be able to fire through this door either.
      const valid = validateRuleStructure(rule);
      if (!valid.ok) {
        console.error(`[sniper/evm] refusing ${token}: synthetic rule is invalid (${valid.reason})`);
        continue;
      }

      // The wallet row is re-synced per fire rather than once at startup so an
      // operator can change the cap and restart nothing. `putWallet` is an
      // upsert and `clampBudgetCaps` is monotonic-down, so this is idempotent
      // and can only ever tighten a day already in progress.
      try {
        await ensureEvmWallet(store, userId, config, utcDay(now()));
      } catch (err) {
        console.error(`[sniper/evm] could not sync the budget wallet; not firing: ${(err as Error)?.message}`);
        continue;
      }

      // Sequential, not Promise.all. Two legs racing into `reserveLeg` is
      // exactly the contention the store is built to survive, but firing them
      // concurrently would also make the ORDER of spend non-deterministic — and
      // when the daily cap bites mid-message, which token got in should be the
      // order they were posted in.
      const result = await fire({
        userId,
        rule,
        tweet: toTokenTrigger(token, now()),
      });

      logOutcome(token, raw.chatId, result);
    }
  };
}

/** `suppressed` is the normal, expected outcome for a re-posted address — logged, not warned. */
function logOutcome(token: string, chatId: string, result: FireResult): void {
  if (result.outcome === 'suppressed') {
    console.log(`[sniper/evm] ${token} already claimed (chat ${chatId}); suppressed.`);
    return;
  }
  if (result.outcome === 'aborted') {
    console.warn(`[sniper/evm] ${token} aborted: ${result.reason ?? 'unknown'}`);
    return;
  }
  for (const leg of result.legs) {
    console.log(
      `[sniper/evm] ${token} leg ${leg.legNo}: ${leg.state}` +
        `${leg.reason ? ` (${leg.reason})` : ''}${leg.signature ? ` tx=${leg.signature}` : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The process-level factory: everything self-gates here so the call site in
 * `index.ts` is one `if`.
 *
 * Returns null — meaning "do not register anything" — when ANY of the following
 * is true. Each is a refusal, not a fallback:
 *
 *   * hosted mode. See the header: a process-scoped key must not be spendable by
 *     a tenant's ingest.
 *   * no `SNIPER_EVM_TRIGGER_CHAT_IDS`. The allowlist has no safe default, so an
 *     absent one arms nothing.
 *
 * Note what is deliberately NOT a gate: the presence of the signing key. The
 * trigger arms without one, runs routing and both pre-trade gates, and refuses
 * at the signature with `no_credential`. That is what makes a keyless
 * deployment a rehearsal of the real path rather than a different path.
 */
export function createProcessTelegramEvmTrigger(
  userId: string,
  deps: { hosted: boolean; config: EvmSniperConfig; store: SniperStore },
): ((raw: TelegramRawMessage) => Promise<void>) | null {
  if (deps.hosted) {
    if (deps.config.triggerChatIds.size > 0) {
      console.warn(
        '[sniper/evm] SNIPER_EVM_TRIGGER_CHAT_IDS is set but this process is in HOSTED mode; ' +
          'the trigger stays disarmed. A process-wide signing key cannot be scoped to one tenant.',
      );
    }
    return null;
  }

  const listener = createTelegramEvmTrigger({ userId, config: deps.config, store: deps.store });
  if (!listener) return null;

  console.log(
    `[sniper/evm] trigger armed for ${deps.config.triggerChatIds.size} chat(s): ` +
      `${deps.config.buyEth} ETH/fire, ${deps.config.dailyCapEth} ETH/day cap, ` +
      `liquidity gate ${deps.config.liquidityGateEnabled ? 'on' : 'OFF'}, ` +
      `sell-sim gate ${deps.config.sellSimGateEnabled ? 'on' : 'OFF'}.`,
  );
  return listener;
}
