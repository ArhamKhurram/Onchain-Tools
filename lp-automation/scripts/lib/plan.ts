// Pure builders for the owner-signed Safe transactions this tooling CANNOT send.
//
// Plan §9 point 3: the Safe owner key is deliberately offline and is never
// handed to this process. So `enableModule.ts` and `seedAllowlist.ts` do not
// sign, do not broadcast, and hold no key — they produce `to` / `value` / `data`
// triples for a human to execute through the Safe UI or their own wallet.
//
// Producing the payload is exactly the part worth testing (a wrong `data` here
// is a wrong allowlist forever), and exactly the part that needs no chain. So it
// lives here, pure, and the scripts are thin shells around it.
//
// Covered by `test/scripts.test.ts`.

import { encodeFunctionData, type Address, type PublicClient } from 'viem';
import { MODULE_ABI, SAFE_ABI } from './abi.js';
import { ROBINHOOD_ALLOWLIST, type AllowlistDestination } from './constants.js';

/**
 * One transaction a Safe owner must sign. Inert data — there is no method on
 * this that can send anything.
 */
export interface SafeTxPayload {
  /** Short id used in output and in the "sign these in this order" checklist. */
  readonly id: string;
  /** Plain-English statement of the effect, for the human doing the signing. */
  readonly description: string;
  /** Why this step exists / what breaks if it is skipped or reordered. */
  readonly rationale: string;
  readonly to: Address;
  readonly value: bigint;
  readonly data: `0x${string}`;
  /** Human-readable decode of the call, argument by argument. */
  readonly decoded: readonly string[];
}

/**
 * `safe.enableModule(module)`.
 *
 * Note the destination: the Safe itself. This is the one payload in the whole
 * setup that targets the Safe, and it is exactly the call the module's operator
 * path can never make (`ForbiddenTarget`) — which is why it has to be signed by
 * an owner.
 */
export function buildEnableModulePayload(safe: Address, module: Address): SafeTxPayload {
  return {
    id: 'enable-module',
    description: `Enable OctAutomationModule ${module} as a module on Safe ${safe}`,
    rationale:
      'Until this executes, the module can do nothing at all — every execute() call reverts inside ' +
      'the Safe. Conversely, once enabled the module can move funds subject only to its own ' +
      'allowlist and caps, so do not enable a module whose constructor arguments you have not read back from chain.',
    to: safe,
    value: 0n,
    data: encodeFunctionData({ abi: SAFE_ABI, functionName: 'enableModule', args: [module] }),
    decoded: [`module = ${module}`],
  };
}

/** `safe.disableModule(prevModule, module)` — the kill switch, pre-encoded. */
export function buildDisableModulePayload(
  safe: Address,
  prevModule: Address,
  module: Address,
): SafeTxPayload {
  return {
    id: 'disable-module',
    description: `Remove module ${module} from Safe ${safe} entirely`,
    rationale:
      'Total kill switch. Handled by Safe\'s own audited code, so it works even if OctAutomationModule ' +
      'is buggy. `prevModule` is the entry BEFORE the module in the Safe\'s linked list — read it from ' +
      'getModulesPaginated, do not guess it.',
    to: safe,
    value: 0n,
    data: encodeFunctionData({ abi: SAFE_ABI, functionName: 'disableModule', args: [prevModule, module] }),
    decoded: [`prevModule = ${prevModule}`, `module = ${module}`],
  };
}

/** `module.setPaused(true|false)` — the fast halt, pre-encoded. */
export function buildSetPausedPayload(module: Address, paused: boolean): SafeTxPayload {
  return {
    id: paused ? 'pause' : 'unpause',
    description: paused
      ? `HALT all operator execution on module ${module}`
      : `Resume operator execution on module ${module}`,
    rationale: paused
      ? 'One owner-signed transaction stops the automation dead without touching the allowlist, the ' +
        'operator set, or the Safe. This is the first thing to send if something looks wrong.'
      : 'Only send this after you know why you paused and the cause is gone.',
    to: module,
    value: 0n,
    data: encodeFunctionData({ abi: MODULE_ABI, functionName: 'setPaused', args: [paused] }),
    decoded: [`newPaused = ${paused}`],
  };
}

export interface AllowlistPlanInput {
  readonly module: Address;
  readonly operator: Address;
  /** false produces the exact inverse plan, for decommissioning or key rotation. */
  readonly allowed?: boolean;
  /** Defaults to the verified Robinhood Chain allowlist. Injectable for tests. */
  readonly destinations?: readonly AllowlistDestination[];
  /** When false, omit setOperator (for --delta updates where the operator is already armed). */
  readonly includeOperator?: boolean;
}

/**
 * The full seeding plan: 5 owner-signed transactions.
 *
 * Ordering is load-bearing and matches `contracts/README.md` §5:
 *
 *   1-2. targets      3-4. selectors      5. operator (LAST)
 *
 * Authorizing the operator last means there is never a window in which an
 * authorized hot key faces a half-configured module. If you sign these out of
 * order, close that window by keeping the module paused until step 5 lands.
 *
 * `setSelectorsAllowed` (batch) is used rather than repeated
 * `setSelectorAllowed` calls specifically to reduce the number of owner
 * signatures: 5 transactions instead of 6, and one fewer chance to sign the
 * wrong thing.
 */
export function buildAllowlistPlan(input: AllowlistPlanInput): SafeTxPayload[] {
  const allowed = input.allowed ?? true;
  const destinations = input.destinations ?? ROBINHOOD_ALLOWLIST;
  const verb = allowed ? 'Allow' : 'REVOKE';
  const payloads: SafeTxPayload[] = [];

  for (const dest of destinations) {
    payloads.push({
      id: `target:${dest.address}`,
      description: `${verb} destination ${dest.address} (${dest.name})`,
      rationale: allowed
        ? 'The module will forward calls from the Safe to this contract. Verify this address against ' +
          'Krystal\'s own published deployments before signing — an allowlisted wrong address is ' +
          'unrecoverable, the module will faithfully enforce a bad rule.'
        : 'Removing a target leaves its selector entries in place. They are inert while the target is ' +
          'not allowlisted, but re-allowlisting the target restores them. Revoke selectors too if that matters.',
      to: input.module,
      value: 0n,
      data: encodeFunctionData({
        abi: MODULE_ABI,
        functionName: 'setTargetAllowed',
        args: [dest.address, allowed],
      }),
      decoded: [`target  = ${dest.address}`, `allowed = ${allowed}`],
    });
  }

  for (const dest of destinations) {
    payloads.push({
      id: `selectors:${dest.address}`,
      description:
        `${verb} ${dest.selectors.length} selector(s) on ${dest.address} (${dest.name})`,
      rationale:
        'The selector allowlist is scoped PER DESTINATION — allowlisting a selector on one contract ' +
        'does not allow it on the other. Batched into one call so this costs one owner signature, not one per selector.',
      to: input.module,
      value: 0n,
      data: encodeFunctionData({
        abi: MODULE_ABI,
        functionName: 'setSelectorsAllowed',
        args: [dest.address, [...dest.selectors], allowed],
      }),
      decoded: [
        `target    = ${dest.address}`,
        ...dest.selectors.map(
          (sel) => `selector  = ${sel}  (${dest.selectorPurpose[sel] ?? 'UNDOCUMENTED — do not sign'})`,
        ),
        `allowed   = ${allowed}`,
      ],
    });
  }

  if (input.includeOperator !== false) {
    payloads.push({
      id: `operator:${input.operator}`,
      description: `${verb} operator (automation hot key) ${input.operator}`,
      rationale: allowed
        ? 'SIGN THIS LAST. It is the moment the hot key becomes able to act. Before signing, confirm ' +
          'this address is NOT one of the Safe\'s owners and that it is a freshly generated wallet ' +
          'holding gas only.'
        : 'Revoking the operator stops the automation without touching the allowlist — the right move ' +
          'for a planned key rotation. For an active compromise use setPaused(true) instead: it is one ' +
          'transaction and it stops every operator at once.',
      to: input.module,
      value: 0n,
      data: encodeFunctionData({
        abi: MODULE_ABI,
        functionName: 'setOperator',
        args: [input.operator, allowed],
      }),
      decoded: [`operator = ${input.operator}`, `allowed  = ${allowed}`],
    });
  }

  return payloads;
}

/** Destinations whose target and/or selectors are not yet allowlisted on-chain. */
export async function destinationsNeedingAllowlist(
  client: PublicClient,
  module: Address,
  destinations: readonly AllowlistDestination[] = ROBINHOOD_ALLOWLIST,
): Promise<AllowlistDestination[]> {
  const missing: AllowlistDestination[] = [];
  for (const dest of destinations) {
    const targetAllowed = (await client.readContract({
      address: module,
      abi: MODULE_ABI,
      functionName: 'isAllowedTarget',
      args: [dest.address],
    })) as boolean;
    if (!targetAllowed) {
      missing.push(dest);
      continue;
    }
    for (const sel of dest.selectors) {
      const selectorAllowed = (await client.readContract({
        address: module,
        abi: MODULE_ABI,
        functionName: 'isAllowedSelector',
        args: [dest.address, sel],
      })) as boolean;
      if (!selectorAllowed) {
        missing.push(dest);
        break;
      }
    }
  }
  return missing;
}

/** True when setOperator(true) still needs to be signed for this hot key. */
export async function operatorNeedsAuthorization(
  client: PublicClient,
  module: Address,
  operator: Address,
): Promise<boolean> {
  const authorized = (await client.readContract({
    address: module,
    abi: MODULE_ABI,
    functionName: 'isOperator',
    args: [operator],
  })) as boolean;
  return !authorized;
}

/**
 * Render one payload for a human to copy into the Safe UI.
 *
 * Pure, and tested, because this text is the whole product of the two scripts
 * that cannot sign. Everything a signer needs to check is on screen: the full
 * destination, the value, the complete calldata, and a decode of every argument.
 * Nothing is truncated — an abbreviated address is exactly what an address
 * substitution survives.
 */
export function renderPayload(payload: SafeTxPayload, index: number, total: number): string {
  const lines: string[] = [];
  lines.push(`  [${index + 1}/${total}] ${payload.description}`);
  lines.push('');
  lines.push(`      to      ${payload.to}`);
  lines.push(`      value   ${payload.value.toString()}   (must be 0)`);
  lines.push(`      data    ${payload.data}`);
  lines.push('');
  lines.push('      decodes to:');
  for (const line of payload.decoded) lines.push(`        ${line}`);
  lines.push('');
  lines.push('      why:');
  for (const line of wrapText(payload.rationale, 88)) lines.push(`        ${line}`);
  return lines.join('\n');
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// Expected-state model, used by verifySetup
// ---------------------------------------------------------------------------

/** A (destination, selector) pair, normalized lowercase for set comparison. */
export type SelectorKey = `${string}:${string}`;

export function selectorKey(target: string, selector: string): SelectorKey {
  return `${target.toLowerCase()}:${selector.toLowerCase()}` as SelectorKey;
}

export interface ExpectedState {
  readonly targets: ReadonlySet<string>;
  readonly selectors: ReadonlySet<SelectorKey>;
  readonly operators: ReadonlySet<string>;
}

export function buildExpectedState(
  operator: Address,
  destinations: readonly AllowlistDestination[] = ROBINHOOD_ALLOWLIST,
): ExpectedState {
  const targets = new Set<string>();
  const selectors = new Set<SelectorKey>();
  for (const dest of destinations) {
    targets.add(dest.address.toLowerCase());
    for (const sel of dest.selectors) selectors.add(selectorKey(dest.address, sel));
  }
  return { targets, selectors, operators: new Set([operator.toLowerCase()]) };
}

/** What the chain currently says is enabled, gathered by replaying module events. */
export interface ObservedState {
  readonly targets: readonly string[];
  readonly selectors: readonly SelectorKey[];
  readonly operators: readonly string[];
}

export interface AllowlistFindings {
  readonly missingTargets: string[];
  readonly missingSelectors: SelectorKey[];
  readonly missingOperators: string[];
  /** Anything live on-chain that is not in the expected set. Treat as hostile. */
  readonly unexpectedTargets: string[];
  readonly unexpectedSelectors: SelectorKey[];
  readonly unexpectedOperators: string[];
  readonly ok: boolean;
}

/**
 * Diff on-chain state against the intended state, in both directions.
 *
 * The reverse direction is the one that matters. "Is what I wanted present?"
 * catches a botched setup; "is anything else present?" catches a compromise or
 * a fat-fingered extra signature — and that is the one you would otherwise
 * never look for, because a working system looks working either way.
 */
export function classifyAllowlist(expected: ExpectedState, observed: ObservedState): AllowlistFindings {
  const obsTargets = new Set(observed.targets.map((t) => t.toLowerCase()));
  const obsSelectors = new Set(observed.selectors.map((s) => s.toLowerCase() as SelectorKey));
  const obsOperators = new Set(observed.operators.map((o) => o.toLowerCase()));

  const missingTargets = [...expected.targets].filter((t) => !obsTargets.has(t));
  const missingSelectors = [...expected.selectors].filter((s) => !obsSelectors.has(s));
  const missingOperators = [...expected.operators].filter((o) => !obsOperators.has(o));

  const unexpectedTargets = [...obsTargets].filter((t) => !expected.targets.has(t));
  const unexpectedSelectors = [...obsSelectors].filter((s) => !expected.selectors.has(s));
  const unexpectedOperators = [...obsOperators].filter((o) => !expected.operators.has(o));

  return {
    missingTargets,
    missingSelectors,
    missingOperators,
    unexpectedTargets,
    unexpectedSelectors,
    unexpectedOperators,
    ok:
      missingTargets.length === 0 &&
      missingSelectors.length === 0 &&
      missingOperators.length === 0 &&
      unexpectedTargets.length === 0 &&
      unexpectedSelectors.length === 0 &&
      unexpectedOperators.length === 0,
  };
}
