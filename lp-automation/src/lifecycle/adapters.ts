// Real implementations of the lifecycle ports.
//
// This is the ONLY file under `src/lifecycle/` that performs I/O. Keeping it
// separate is what lets `loop.ts` and `executor.ts` be unit-tested with fakes,
// with no network and no chain — which matters more here than usual, because
// the behaviours that need testing are the ones you cannot provoke against a
// live system on demand (an audit write failing, a signer rejecting, a policy
// changing between the decision and the broadcast).
//
// Nothing here signs. The Krystal wrappers return inert `PreparedTransaction`s
// and the tick reader is a read-only `eth_call`.

import { readFile } from 'node:fs/promises';
import { buildAdjustRange, buildCompound, buildSwapAndIncrease, buildSwapAndMint, type LpTxnContext } from '../calldata/lpTxn.js';
import type { PreparedTransaction } from '../calldata/types.js';
import { KrystalFieldError } from '../ingest/krystal/coerce.js';
import type { KrystalClient } from '../ingest/krystal/client.js';
import { mapUserPositions, USER_POSITIONS_PATH } from '../ingest/krystal/positions.js';
import type { PoolTickState } from '../ingest/krystal/positions.js';
import { DEFAULT_POLICY, validatePolicy } from '../policy/index.js';
import type { Address, AutomationPolicy, LpPosition } from '../types.js';
import type { CalldataBuilder, Logger, PolicyBundle, PolicySource, PositionFeed } from './types.js';

// --- positions --------------------------------------------------------------

export interface KrystalPositionFeedOptions {
  client: KrystalClient;
  chainId: number;
  /** The Safe. Positions are read for this address only. */
  owner: Address;
  /**
   * Authoritative current tick for a pool, read from the chain.
   *
   * REQUIRED, and required to be RPC-backed: Krystal's `pool.price` drifted up
   * to 66 ticks from `slot0()` when measured, and the range-exit trigger is
   * exactly where that error would land (plan §3). A pool whose tick cannot be
   * read has its positions skipped, never backfilled.
   */
  readTick: (pool: Address) => Promise<number>;
  logger: Logger;
}

export class KrystalPositionFeed implements PositionFeed {
  constructor(private readonly options: KrystalPositionFeedOptions) {}

  async loadPositions(): Promise<LpPosition[]> {
    const { client, chainId, owner, logger } = this.options;

    const raw = await client.getJson(USER_POSITIONS_PATH, {
      addresses: owner,
      chainIds: chainId,
      positionStatus: 'open',
    });

    // The tick has to be read per pool, and the pool set is only knowable from
    // the payload — hence the raw pass before mapping. `mapUserPositions` then
    // does all of the actual interpretation.
    const pools = extractPoolAddresses(raw);
    const currentTicks = new Map<Address, PoolTickState>();
    await Promise.all(
      pools.map(async (pool) => {
        try {
          currentTicks.set(pool, { currentTick: await this.options.readTick(pool) });
        } catch (error) {
          // Positions in this pool will be skipped by the mapper, with a reason.
          // That is the correct outcome: no tick, no range judgement.
          logger.warn('lp-lifecycle: could not read current tick; positions in this pool are skipped', {
            pool,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    const mapped = mapUserPositions(raw, { chainId, currentTicks });
    for (const entry of mapped.skipped) {
      logger.warn('lp-lifecycle: position skipped by the Krystal mapper', entry as unknown as Record<string, unknown>);
    }
    for (const entry of mapped.incomplete) {
      // `volume24hUsd: 0` here means UNKNOWN, not "no volume" — see
      // `IncompletePosition` in `ingest/krystal/positions.ts`.
      logger.warn('lp-lifecycle: position has placeholder pool fields', {
        tokenId: entry.tokenId,
        missing: entry.missing,
      });
    }
    return mapped.positions;
  }
}

/** Defensive walk of `{ positions: [{ pool: { poolAddress } }] }`. */
function extractPoolAddresses(raw: unknown): Address[] {
  const found = new Set<Address>();
  if (typeof raw !== 'object' || raw === null) return [];
  const positions = (raw as { positions?: unknown }).positions;
  if (!Array.isArray(positions)) return [];
  for (const row of positions) {
    if (typeof row !== 'object' || row === null) continue;
    const pool = (row as { pool?: unknown }).pool;
    if (typeof pool !== 'object' || pool === null) continue;
    const address = (pool as { poolAddress?: unknown }).poolAddress;
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    found.add(address.toLowerCase() as Address);
  }
  return [...found];
}

// --- calldata ---------------------------------------------------------------

export interface KrystalCalldataOptions {
  context: LpTxnContext;
  /** Fractions, guarded again inside `lpTxn.ts`: 0.005 is 0.5%. */
  swapSlippage: number;
  liquiditySlippage: number;
}

export class KrystalCalldataBuilder implements CalldataBuilder {
  constructor(private readonly options: KrystalCalldataOptions) {}

  compound(request: { position: LpPosition }): Promise<PreparedTransaction> {
    return buildCompound(this.options.context, {
      tokenId: request.position.tokenId,
      swapSlippage: this.options.swapSlippage,
      liquiditySlippage: this.options.liquiditySlippage,
    });
  }

  rebalance(request: {
    position: LpPosition;
    tickLower: number;
    tickUpper: number;
  }): Promise<PreparedTransaction> {
    // Rebalance embeds swap min-outs at quote time; stale calldata can revert or execute at worse prices.
    return buildAdjustRange(this.options.context, {
      tokenId: request.position.tokenId,
      newTickLower: request.tickLower,
      newTickUpper: request.tickUpper,
      swapSlippage: this.options.swapSlippage,
      liquiditySlippage: this.options.liquiditySlippage,
    });
  }

  enter(request: {
    poolAddress: Address;
    tokenInAddress: Address;
    amountIn: string;
    tickLower: number;
    tickUpper: number;
    swapSlippage?: number;
  }): Promise<PreparedTransaction> {
    return buildSwapAndMint(this.options.context, {
      poolAddress: request.poolAddress,
      tickLower: request.tickLower,
      tickUpper: request.tickUpper,
      tokenInAddress: request.tokenInAddress,
      amountIn: request.amountIn,
      swapSlippage: request.swapSlippage ?? this.options.swapSlippage,
      liquiditySlippage: this.options.liquiditySlippage,
    });
  }

  increase(request: {
    position: LpPosition;
    tokenInAddress: Address;
    amountIn: string;
    swapSlippage?: number;
  }): Promise<PreparedTransaction> {
    return buildSwapAndIncrease(this.options.context, {
      tokenId: request.position.tokenId,
      tokenInAddress: request.tokenInAddress,
      amountIn: request.amountIn,
      swapSlippage: request.swapSlippage ?? this.options.swapSlippage,
      liquiditySlippage: this.options.liquiditySlippage,
    });
  }
}

// --- policy -----------------------------------------------------------------

/**
 * Policy read from a local JSON file.
 *
 * The policy is authored in the dashboard and only ever READ here (plan §9
 * point 1) — this process never writes it back, and there is deliberately no
 * inbound surface for pushing one in. A file is the smallest thing that
 * satisfies "read-only, and replaceable without a deploy"; swapping this for a
 * Supabase reader later is a drop-in of the same port.
 *
 * Accepted shapes:
 *   { "policies": [...], "bindings": { "<tokenId>": <version> } }
 *   [ <policy>, ... ]
 *   <policy>
 *
 * NO FILE means `DEFAULT_POLICY`, whose `allowedPools` is empty — so a missing
 * or unreadable policy degrades to "this process can do nothing", never to
 * "this process acts on assumptions".
 */
export class FilePolicySource implements PolicySource {
  constructor(
    private readonly path: string | null,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<PolicyBundle> {
    if (this.path === null) return { policies: [DEFAULT_POLICY], bindings: {} };

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
    } catch (error) {
      this.logger.error(
        'lp-lifecycle: policy file unreadable — falling back to DEFAULT_POLICY, whose empty ' +
          'allowlist authorizes nothing',
        { path: this.path, error: error instanceof Error ? error.message : String(error) },
      );
      return { policies: [DEFAULT_POLICY], bindings: {} };
    }

    const policies = Array.isArray(parsed)
      ? (parsed as AutomationPolicy[])
      : isRecord(parsed) && Array.isArray(parsed.policies)
        ? (parsed.policies as AutomationPolicy[])
        : [parsed as AutomationPolicy];

    const bindings: Record<string, number> = {};
    if (isRecord(parsed) && isRecord(parsed.bindings)) {
      for (const [tokenId, version] of Object.entries(parsed.bindings)) {
        if (typeof version === 'number' && Number.isInteger(version) && version > 0) {
          bindings[tokenId] = version;
          continue;
        }
        // A binding we cannot read would silently become "inherit the default",
        // i.e. the retroactive policy application `versioning.ts` forbids.
        this.logger.error('lp-lifecycle: ignoring unreadable policy binding', { tokenId, version });
      }
    }

    // Validation also happens in the loop; doing it here too means the startup
    // banner can report a genuinely usable policy rather than a hopeful one.
    for (const policy of policies) {
      const result = validatePolicy(policy);
      if (!result.valid) {
        this.logger.error('lp-lifecycle: policy file contains an invalid version', {
          path: this.path,
          issues: result.issues,
        });
      }
    }

    return { policies, bindings };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Re-exported so a caller can distinguish a mapper rejection from a transport error. */
export { KrystalFieldError };
