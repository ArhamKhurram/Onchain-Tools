// Unit tests for the signing layer (`src/signer/`).
//
// NO NETWORK, NO CHAIN, NO REAL KEY. The clients are plain objects; the only
// private key that appears is Anvil's first well-known test key, which is
// published in Foundry's own documentation and holds nothing anywhere.
//
// What these tests are actually for: the signer's job is to REFUSE. Its happy
// path is one line of code and its value is entirely in the eight ways it
// declines. So most of what follows asserts a rejection, at a named stage, for
// a specific reason — including the cases where the reason is "I could not
// check", which must never be treated as "fine".

import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';

import {
  ARM_ENV_VAR,
  ModuleTransactionSigner,
  PREFLIGHT_ORDER,
  SignerConfigError,
  createModuleClients,
  resolveSimulationAccount,
  parseArmState,
  parseSignerConfig,
  readOperatorPrivateKey,
  type ContractReadRequest,
  type ContractSimulateRequest,
  type PreflightStage,
  type SignerConfig,
  type SignerPublicClient,
  type SignerWalletClient,
} from '../src/signer/index.js';
import type { PreparedTransaction } from '../src/calldata/types.js';
import { ROBINHOOD_CHAIN_ID, type Address } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Anvil account #0. Published in Foundry's docs, funded only on throwaway local
 * chains, and used here purely to exercise real key -> address derivation. It
 * is also the string every "the key must not leak" assertion searches for.
 */
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_PRIVATE_KEY_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

const SAFE = '0x1111111111111111111111111111111111111111' as Address;
const MODULE = '0x2222222222222222222222222222222222222222' as Address;
const OPERATOR = '0x3333333333333333333333333333333333333333' as Address;
/** The real Krystal v3utils helper on 4663 (plan §4). */
const TARGET = '0xb4acbc082b5e7ded571c98ee4257778a9d784b36' as Address;
const SELECTOR = '0x954543e6' as const;
const TX_HASH = `0x${'ab'.repeat(32)}` as const;

const RPC_URL = 'https://rpc.example.invalid';

const BASE_CONFIG: SignerConfig = {
  rpcUrl: RPC_URL,
  safeAddress: SAFE,
  moduleAddress: MODULE,
  chainId: ROBINHOOD_CHAIN_ID,
  armState: 'disarmed',
};

function makeTx(overrides: Partial<PreparedTransaction> = {}): PreparedTransaction {
  const meta = {
    kind: 'swap_and_mint' as const,
    chainId: ROBINHOOD_CHAIN_ID,
    platform: 'uniswapv3',
    from: SAFE,
    selector: SELECTOR as `0x${string}`,
    estimateGas: 500_000n,
    gasLimit: 600_000n,
    usedDefaultGas: false,
    builtAt: 1_700_000_000_000,
    txInfo: null,
    ...(overrides.meta ?? {}),
  };
  return {
    to: TARGET,
    value: 0n,
    data: `${SELECTOR}${'11'.repeat(64)}` as `0x${string}`,
    ...overrides,
    meta,
  };
}

function makeRequest(tx: PreparedTransaction = makeTx(), auditId = 'audit-001') {
  return { transaction: tx, action: 'compound' as const, auditId };
}

/** A stub that throws when read, standing in for a dead or flaky RPC. */
function throwing(message: string): () => never {
  return () => {
    throw new Error(message);
  };
}

type ReadStub = unknown | (() => unknown);

const DEFAULT_READS: Record<string, ReadStub> = {
  safe: SAFE,
  isModuleEnabledOnSafe: true,
  paused: false,
  isOperator: true,
  isAllowedTarget: true,
  isAllowedSelector: true,
  maxValuePerTx: 10n ** 18n,
  remainingDailyAllowance: 10n ** 18n,
};

class FakePublicClient implements SignerPublicClient {
  readonly reads: { functionName: string; args: readonly unknown[] }[] = [];
  readonly simulations: ContractSimulateRequest[] = [];
  simulateImpl: (request: ContractSimulateRequest) => Promise<{ request: unknown }> = async () => ({
    request: { __simulated: true },
  });

  constructor(private readonly stubs: Record<string, ReadStub> = {}) {}

  async readContract(request: ContractReadRequest): Promise<unknown> {
    this.reads.push({ functionName: request.functionName, args: request.args ?? [] });
    const merged = { ...DEFAULT_READS, ...this.stubs };
    if (!(request.functionName in merged)) {
      throw new Error(`test stub missing for ${request.functionName}`);
    }
    const stub = merged[request.functionName];
    return typeof stub === 'function' ? (stub as () => unknown)() : stub;
  }

  async simulateContract(request: ContractSimulateRequest): Promise<{ request: unknown }> {
    this.simulations.push(request);
    return this.simulateImpl(request);
  }
}

class FakeWalletClient implements SignerWalletClient {
  readonly writes: unknown[] = [];
  impl: (request: unknown) => Promise<`0x${string}`> = async () => TX_HASH;

  async writeContract(request: unknown): Promise<`0x${string}`> {
    this.writes.push(request);
    return this.impl(request);
  }
}

interface Harness {
  signer: ModuleTransactionSigner;
  publicClient: FakePublicClient;
  walletClient: FakeWalletClient;
}

function makeSigner(
  options: { armState?: 'armed' | 'disarmed'; reads?: Record<string, ReadStub>; config?: Partial<SignerConfig> } = {},
): Harness {
  const publicClient = new FakePublicClient(options.reads ?? {});
  const walletClient = new FakeWalletClient();
  const signer = new ModuleTransactionSigner({
    config: { ...BASE_CONFIG, armState: options.armState ?? 'disarmed', ...options.config },
    publicClient,
    walletClient,
    operatorAddress: OPERATOR,
  });
  return { signer, publicClient, walletClient };
}

/** JSON.stringify that survives bigints, so the leak scan can cover status objects. */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? `${val}` : val)) ?? '';
}

// ---------------------------------------------------------------------------
// The arm gate
// ---------------------------------------------------------------------------

describe('parseArmState', () => {
  it('arms on exactly "true" and nothing else', () => {
    expect(parseArmState('true')).toBe('armed');
  });

  // Every one of these has been someone's "but I set the flag" incident.
  const mustNotArm = [
    undefined,
    null,
    '',
    ' ',
    '1',
    'yes',
    'Yes',
    'on',
    'TRUE',
    'True',
    'tRuE',
    ' true',
    'true ',
    ' true ',
    '"true"',
    "'true'",
    'true\n',
    'truthy',
    'enabled',
    '0',
    'false',
    'no',
  ];

  it.each(mustNotArm)('stays disarmed for %o', (value) => {
    expect(parseArmState(value as string | undefined)).toBe('disarmed');
  });

  it('defaults to disarmed when the env var is absent entirely', () => {
    const config = parseSignerConfig({
      LP_RPC_URL: RPC_URL,
      LP_SAFE_ADDRESS: SAFE,
      LP_MODULE_ADDRESS: MODULE,
    });
    expect(config.armState).toBe('disarmed');
    expect(ARM_ENV_VAR).toBe('LP_ARMED');
  });

  it('arms only via LP_ARMED=true in a full config parse', () => {
    const base = { LP_RPC_URL: RPC_URL, LP_SAFE_ADDRESS: SAFE, LP_MODULE_ADDRESS: MODULE };
    expect(parseSignerConfig({ ...base, [ARM_ENV_VAR]: 'true' }).armState).toBe('armed');
    expect(parseSignerConfig({ ...base, [ARM_ENV_VAR]: 'TRUE' }).armState).toBe('disarmed');
    expect(parseSignerConfig({ ...base, [ARM_ENV_VAR]: '1' }).armState).toBe('disarmed');
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('parseSignerConfig', () => {
  const base = { LP_RPC_URL: RPC_URL, LP_SAFE_ADDRESS: SAFE, LP_MODULE_ADDRESS: MODULE };

  it('pins the chain id rather than reading it from env', () => {
    expect(parseSignerConfig({ ...base, LP_CHAIN_ID: '1' } as Record<string, string>).chainId).toBe(
      ROBINHOOD_CHAIN_ID,
    );
  });

  it('lowercases addresses', () => {
    const config = parseSignerConfig({ ...base, LP_SAFE_ADDRESS: SAFE.toUpperCase().replace('0X', '0x') });
    expect(config.safeAddress).toBe(SAFE);
  });

  it.each([
    ['LP_RPC_URL', { ...base, LP_RPC_URL: '' }],
    ['LP_RPC_URL not a url', { ...base, LP_RPC_URL: 'not-a-url' }],
    ['LP_RPC_URL wrong scheme', { ...base, LP_RPC_URL: 'wss://example.invalid' }],
    ['LP_SAFE_ADDRESS missing', { ...base, LP_SAFE_ADDRESS: '' }],
    ['LP_SAFE_ADDRESS malformed', { ...base, LP_SAFE_ADDRESS: '0x123' }],
    ['LP_SAFE_ADDRESS zero', { ...base, LP_SAFE_ADDRESS: `0x${'0'.repeat(40)}` }],
    ['LP_MODULE_ADDRESS missing', { ...base, LP_MODULE_ADDRESS: undefined }],
    ['safe == module', { ...base, LP_MODULE_ADDRESS: SAFE }],
  ])('rejects %s', (_label, env) => {
    expect(() => parseSignerConfig(env as Record<string, string | undefined>)).toThrow(SignerConfigError);
  });

  it('has no field capable of holding key material', () => {
    const config = parseSignerConfig({ ...base, LP_OPERATOR_PRIVATE_KEY: TEST_PRIVATE_KEY });
    expect(stringify(config)).not.toContain(TEST_PRIVATE_KEY);
    expect(Object.values(config)).not.toContain(TEST_PRIVATE_KEY);
  });
});

// ---------------------------------------------------------------------------
// Disarmed: everything runs except the send
// ---------------------------------------------------------------------------

describe('submit() while disarmed', () => {
  it('runs the whole ladder, simulates, and refuses to broadcast', async () => {
    const { signer, publicClient, walletClient } = makeSigner({ armState: 'disarmed' });

    const outcome = await signer.submit(makeRequest(makeTx({ value: 10n })));

    expect(outcome).toMatchObject({ status: 'skipped_disarmed', simulated: true, auditId: 'audit-001' });
    // The point of disarmed mode: it tells you what an armed run would do.
    expect(publicClient.simulations).toHaveLength(1);
    expect(walletClient.writes).toHaveLength(0);

    // Every on-chain check was actually performed, not skipped as pointless.
    const read = publicClient.reads.map((entry) => entry.functionName);
    expect(read).toContain('safe');
    expect(read).toContain('isModuleEnabledOnSafe');
    expect(read).toContain('paused');
    expect(read).toContain('isOperator');
    expect(read).toContain('isAllowedTarget');
    expect(read).toContain('isAllowedSelector');
    expect(read).toContain('maxValuePerTx');
    expect(read).toContain('remainingDailyAllowance');
  });

  it('still rejects at the correct stage rather than reporting skipped_disarmed', async () => {
    const { signer, walletClient } = makeSigner({ armState: 'disarmed', reads: { isAllowedTarget: false } });

    const outcome = await signer.submit(makeRequest());

    expect(outcome.status).toBe('rejected');
    expect(outcome).toMatchObject({ stage: 'destination_allowlist' });
    expect(walletClient.writes).toHaveLength(0);
  });

  it('performs the on-chain reads in the documented ladder order', async () => {
    const { signer, publicClient } = makeSigner({ armState: 'disarmed' });
    await signer.submit(makeRequest(makeTx({ value: 10n })));

    const stageOf: Record<string, PreflightStage> = {
      safe: 'module_enabled',
      isModuleEnabledOnSafe: 'module_enabled',
      paused: 'module_enabled',
      isOperator: 'module_enabled',
      isAllowedTarget: 'destination_allowlist',
      isAllowedSelector: 'selector_allowlist',
      maxValuePerTx: 'value_cap',
      remainingDailyAllowance: 'daily_allowance',
    };
    const observed = publicClient.reads.map((entry) => PREFLIGHT_ORDER.indexOf(stageOf[entry.functionName]!));
    expect(observed).toEqual([...observed].sort((a, b) => a - b));
  });

  it('does not consult the daily allowance for a zero-value transaction', async () => {
    // Mirrors the module: `_recordSpend` short-circuits at zero, so a zero-value
    // execution succeeds even with the bucket exhausted.
    const { signer, publicClient } = makeSigner({
      armState: 'disarmed',
      reads: { remainingDailyAllowance: throwing('should not be read') },
    });

    const outcome = await signer.submit(makeRequest(makeTx({ value: 0n })));

    expect(outcome.status).toBe('skipped_disarmed');
    expect(publicClient.reads.map((entry) => entry.functionName)).not.toContain('remainingDailyAllowance');
  });
});

// ---------------------------------------------------------------------------
// Armed
// ---------------------------------------------------------------------------

describe('submit() while armed', () => {
  it('broadcasts the simulated request verbatim', async () => {
    const { signer, publicClient, walletClient } = makeSigner({ armState: 'armed' });
    publicClient.simulateImpl = async () => ({ request: { marker: 'simulated' } });

    const outcome = await signer.submit(makeRequest());

    expect(outcome).toEqual({ status: 'broadcast', txHash: TX_HASH, auditId: 'audit-001', armState: 'armed' });
    expect(walletClient.writes).toEqual([{ marker: 'simulated' }]);
  });

  it('simulates from the operator, not the Safe, and never forwards native value', async () => {
    const { signer, publicClient } = makeSigner({ armState: 'armed' });
    await signer.submit(makeRequest(makeTx({ value: 5n })));

    const [simulation] = publicClient.simulations;
    expect(simulation?.account).toBe(OPERATOR);
    expect(simulation?.functionName).toBe('execute');
    expect(simulation?.address).toBe(MODULE);
    expect(simulation?.args).toEqual([TARGET, 5n, makeTx().data]);
    // `execute` is non-payable: value is drawn from the Safe, so the outer call
    // must not carry one.
    expect(simulation && 'value' in simulation).toBe(false);
  });
});

describe('simulate()', () => {
  it('never broadcasts, even when armed', async () => {
    const { signer, publicClient, walletClient } = makeSigner({ armState: 'armed' });

    const result = await signer.simulate(makeRequest());

    expect(result).toEqual({ ok: true });
    expect(publicClient.simulations).toHaveLength(1);
    expect(walletClient.writes).toHaveLength(0);
  });

  it('reports the failing stage', async () => {
    const { signer } = makeSigner({ armState: 'armed', reads: { paused: true } });
    const result = await signer.simulate(makeRequest());
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('module_enabled');
  });
});

// ---------------------------------------------------------------------------
// Every preflight stage rejects with its own stage label
// ---------------------------------------------------------------------------

describe('preflight rejections', () => {
  async function rejectionOf(options: Parameters<typeof makeSigner>[0], request = makeRequest()) {
    const { signer, walletClient } = makeSigner({ armState: 'armed', ...options });
    const outcome = await signer.submit(request);
    expect(walletClient.writes).toHaveLength(0);
    return outcome;
  }

  it('arm_check: transaction built for another chain', async () => {
    const tx = makeTx({ meta: { ...makeTx().meta, chainId: 1 } });
    expect(await rejectionOf({}, makeRequest(tx))).toMatchObject({ status: 'rejected', stage: 'arm_check' });
  });

  it('arm_check: transaction built for an account that is not our Safe', async () => {
    const tx = makeTx({ meta: { ...makeTx().meta, from: '0x9999999999999999999999999999999999999999' as Address } });
    expect(await rejectionOf({}, makeRequest(tx))).toMatchObject({ status: 'rejected', stage: 'arm_check' });
  });

  it('module_enabled: the Safe has not enabled the module', async () => {
    const outcome = await rejectionOf({ reads: { isModuleEnabledOnSafe: false } });
    expect(outcome).toMatchObject({ status: 'rejected', stage: 'module_enabled' });
    expect((outcome as { reason: string }).reason).toContain('has not enabled module');
  });

  it('module_enabled: the module is paused', async () => {
    expect(await rejectionOf({ reads: { paused: true } })).toMatchObject({
      status: 'rejected',
      stage: 'module_enabled',
    });
  });

  it('module_enabled: our operator key is not authorized', async () => {
    expect(await rejectionOf({ reads: { isOperator: false } })).toMatchObject({
      status: 'rejected',
      stage: 'module_enabled',
    });
  });

  it('module_enabled: the module executes out of a different Safe', async () => {
    const outcome = await rejectionOf({ reads: { safe: '0x8888888888888888888888888888888888888888' } });
    expect(outcome).toMatchObject({ status: 'rejected', stage: 'module_enabled' });
  });

  it('destination_allowlist: destination is not allowlisted ON-CHAIN', async () => {
    const outcome = await rejectionOf({ reads: { isAllowedTarget: false } });
    expect(outcome).toMatchObject({ status: 'rejected', stage: 'destination_allowlist' });
    expect((outcome as { reason: string }).reason).toContain('on-chain allowlist');
  });

  it.each([
    ['the Safe', SAFE],
    ['the module itself', MODULE],
    ['the zero address', `0x${'0'.repeat(40)}` as Address],
  ])('destination_allowlist: refuses to target %s', async (_label, to) => {
    // Note the stub says the target IS allowlisted — the local forbidden-target
    // check must reject anyway, exactly as the module's own guard does.
    const outcome = await rejectionOf({ reads: { isAllowedTarget: true } }, makeRequest(makeTx({ to })));
    expect(outcome).toMatchObject({ status: 'rejected', stage: 'destination_allowlist' });
  });

  it('selector_allowlist: selector is not allowlisted for this destination', async () => {
    expect(await rejectionOf({ reads: { isAllowedSelector: false } })).toMatchObject({
      status: 'rejected',
      stage: 'selector_allowlist',
    });
  });

  it('selector_allowlist: calldata is shorter than a selector', async () => {
    const outcome = await rejectionOf({}, makeRequest(makeTx({ data: '0x1234' })));
    expect(outcome).toMatchObject({ status: 'rejected', stage: 'selector_allowlist' });
  });

  it('selector_allowlist: calldata disagrees with the declared selector', async () => {
    const tx = makeTx({ meta: { ...makeTx().meta, selector: '0xdeadbeef' as `0x${string}` } });
    const outcome = await rejectionOf({}, makeRequest(tx));
    expect(outcome).toMatchObject({ status: 'rejected', stage: 'selector_allowlist' });
  });

  it('value_cap: value exceeds the module per-transaction cap', async () => {
    const outcome = await rejectionOf({ reads: { maxValuePerTx: 100n } }, makeRequest(makeTx({ value: 101n })));
    expect(outcome).toMatchObject({ status: 'rejected', stage: 'value_cap' });
  });

  it('value_cap: a value exactly at the cap is allowed', async () => {
    const { signer } = makeSigner({ armState: 'armed', reads: { maxValuePerTx: 100n, remainingDailyAllowance: 100n } });
    expect((await signer.submit(makeRequest(makeTx({ value: 100n })))).status).toBe('broadcast');
  });

  it('daily_allowance: value exceeds what is left in the UTC-day bucket', async () => {
    const outcome = await rejectionOf(
      { reads: { maxValuePerTx: 10n ** 18n, remainingDailyAllowance: 50n } },
      makeRequest(makeTx({ value: 51n })),
    );
    expect(outcome).toMatchObject({ status: 'rejected', stage: 'daily_allowance' });
  });

  it('simulation: a revert is a rejection, not a broadcast', async () => {
    const { signer, publicClient, walletClient } = makeSigner({ armState: 'armed' });
    publicClient.simulateImpl = async () => {
      const error = new Error('execution reverted');
      (error as { shortMessage?: string }).shortMessage = 'SelectorNotAllowed';
      throw error;
    };

    const outcome = await signer.submit(makeRequest());

    expect(outcome).toMatchObject({ status: 'rejected', stage: 'simulation', reason: 'SelectorNotAllowed' });
    expect(walletClient.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fail closed: "could not check" is never "fine"
// ---------------------------------------------------------------------------

describe('fail-closed behaviour', () => {
  const readStages: [string, PreflightStage][] = [
    ['safe', 'module_enabled'],
    ['isModuleEnabledOnSafe', 'module_enabled'],
    ['paused', 'module_enabled'],
    ['isOperator', 'module_enabled'],
    ['isAllowedTarget', 'destination_allowlist'],
    ['isAllowedSelector', 'selector_allowlist'],
    ['maxValuePerTx', 'value_cap'],
    ['remainingDailyAllowance', 'daily_allowance'],
  ];

  it.each(readStages)('an RPC failure reading %s rejects at stage %s', async (functionName, stage) => {
    const { signer, walletClient } = makeSigner({
      armState: 'armed',
      reads: { [functionName]: throwing('HTTP request failed: 503') },
    });

    const outcome = await signer.submit(makeRequest(makeTx({ value: 1n })));

    expect(outcome).toMatchObject({ status: 'rejected', stage });
    expect(walletClient.writes).toHaveLength(0);
  });

  it.each(readStages)('a malformed response for %s rejects at stage %s', async (functionName, stage) => {
    // A node (or a proxy, or a mock) returning the wrong type must not be
    // coerced: `Boolean('false')` is `true`, which would be a silent
    // authorization.
    const bogus = functionName === 'maxValuePerTx' || functionName === 'remainingDailyAllowance' ? '9999' : 'false';
    const { signer, walletClient } = makeSigner({
      armState: 'armed',
      reads: { [functionName]: bogus },
    });

    const outcome = await signer.submit(makeRequest(makeTx({ value: 1n })));

    expect(outcome).toMatchObject({ status: 'rejected', stage });
    expect(walletClient.writes).toHaveLength(0);
  });

  it('a simulation transport failure rejects rather than passing', async () => {
    // An unreachable node is not evidence that a transaction is safe. Unlike
    // `calldata/dryRun.ts`, which rethrows transport errors, the signer folds
    // them into a rejection: there is no caller above it that could do anything
    // safer than decline.
    const { signer, publicClient, walletClient } = makeSigner({ armState: 'armed' });
    publicClient.simulateImpl = async () => {
      const error = new Error('socket hang up');
      error.name = 'HttpRequestError';
      throw error;
    };

    expect(await signer.submit(makeRequest())).toMatchObject({ status: 'rejected', stage: 'simulation' });
    expect(walletClient.writes).toHaveLength(0);
  });

  it('getStatus throws instead of reporting a default it cannot verify', async () => {
    const { signer } = makeSigner({ reads: { isModuleEnabledOnSafe: throwing('HTTP request failed: 503') } });
    await expect(signer.getStatus()).rejects.toThrow(/isModuleEnabledOnSafe\(\) could not be evaluated/);
  });
});

// ---------------------------------------------------------------------------
// Broadcast failures are never retried
// ---------------------------------------------------------------------------

describe('broadcast', () => {
  it('does not retry a failed send', async () => {
    const { signer, walletClient } = makeSigner({ armState: 'armed' });
    walletClient.impl = async () => {
      throw new Error('timeout waiting for response');
    };

    const outcome = await signer.submit(makeRequest());

    // A timed-out send may still land. One attempt, null hash, caller
    // reconciles against the audit log.
    expect(walletClient.writes).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'failed', txHash: null, auditId: 'audit-001' });
  });

  it('reports failed (not broadcast) when the wallet returns something that is not a hash', async () => {
    const { signer, walletClient } = makeSigner({ armState: 'armed' });
    walletClient.impl = async () => 'not-a-hash' as `0x${string}`;

    const outcome = await signer.submit(makeRequest());

    expect(outcome).toMatchObject({ status: 'failed', txHash: null });
    expect((outcome as { reason: string }).reason).toContain('may still have landed');
    expect(walletClient.writes).toHaveLength(1);
  });

  it('echoes the audit id on every outcome shape', async () => {
    const armed = makeSigner({ armState: 'armed' });
    expect(await armed.signer.submit(makeRequest(makeTx(), 'a-1'))).toMatchObject({ auditId: 'a-1' });

    const disarmed = makeSigner({ armState: 'disarmed' });
    expect(await disarmed.signer.submit(makeRequest(makeTx(), 'a-2'))).toMatchObject({ auditId: 'a-2' });

    const rejected = makeSigner({ armState: 'armed', reads: { paused: true } });
    expect(await rejected.signer.submit(makeRequest(makeTx(), 'a-3'))).toMatchObject({ auditId: 'a-3' });

    const failed = makeSigner({ armState: 'armed' });
    failed.walletClient.impl = async () => {
      throw new Error('nope');
    };
    expect(await failed.signer.submit(makeRequest(makeTx(), 'a-4'))).toMatchObject({ auditId: 'a-4' });
  });
});

// ---------------------------------------------------------------------------
// The key must not be observable anywhere
// ---------------------------------------------------------------------------

describe('resolveSimulationAccount', () => {
  const local = { address: TEST_PRIVATE_KEY_ADDRESS.replace(/^0x./, '0xF') } as { address: string };

  it('substitutes the local account so the send signs in-process', () => {
    // Passing an address string instead would make viem use `eth_sendTransaction`
    // and ask the RPC provider — which holds no key — to sign.
    expect(resolveSimulationAccount(TEST_PRIVATE_KEY_ADDRESS as `0x${string}`, local)).toBe(local);
    expect(resolveSimulationAccount(TEST_PRIVATE_KEY_ADDRESS.toUpperCase().replace('0X', '0x') as `0x${string}`, local))
      .toBe(local);
  });

  it('passes a foreign address through rather than silently signing as someone else', () => {
    expect(resolveSimulationAccount(OPERATOR, local)).toBe(OPERATOR);
  });
});

describe('key containment', () => {
  it('derives the operator address without retaining the key anywhere reachable', () => {
    const clients = createModuleClients({ rpcUrl: RPC_URL, privateKey: TEST_PRIVATE_KEY });

    expect(clients.operatorAddress).toBe(TEST_PRIVATE_KEY_ADDRESS);
    expect(stringify(clients)).not.toContain(TEST_PRIVATE_KEY);
    expect(stringify(clients)).not.toContain(TEST_PRIVATE_KEY.slice(2));

    // Deep structural dump, not just the JSON view: viem's account keeps the key
    // in a closure, and nothing may promote it to a property.
    const dump = inspect(clients, { depth: 8 }).toLowerCase();
    // Positive control first — an assertion that the key is absent from an empty
    // string would pass forever. The derived address IS in there, so the dump is
    // reaching the account object.
    expect(dump).toContain(TEST_PRIVATE_KEY_ADDRESS.slice(2));
    expect(dump).not.toContain(TEST_PRIVATE_KEY.slice(2));
  });

  it('serializes the signer to nothing at all', () => {
    const clients = createModuleClients({ rpcUrl: RPC_URL, privateKey: TEST_PRIVATE_KEY });
    const signer = new ModuleTransactionSigner({
      config: BASE_CONFIG,
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      operatorAddress: clients.operatorAddress,
    });

    expect(stringify(signer)).toBe('{}');
    expect(Object.keys(signer)).toEqual([]);
    expect(stringify(signer)).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(inspect(signer, { depth: 8 })).not.toContain(TEST_PRIVATE_KEY.slice(2));
    // The public address is derived from the key and is safe to expose.
    expect(signer.operatorAddress).toBe(TEST_PRIVATE_KEY_ADDRESS);
  });

  it('keeps the key out of status objects and submit outcomes', async () => {
    const clients = createModuleClients({ rpcUrl: RPC_URL, privateKey: TEST_PRIVATE_KEY });
    const publicClient = new FakePublicClient({ safe: SAFE });
    const walletClient = new FakeWalletClient();
    const signer = new ModuleTransactionSigner({
      config: { ...BASE_CONFIG, armState: 'armed' },
      publicClient,
      walletClient,
      operatorAddress: clients.operatorAddress,
    });

    const status = await signer.getStatus();
    const outcome = await signer.submit(makeRequest());

    for (const value of [status, outcome]) {
      expect(stringify(value)).not.toContain(TEST_PRIVATE_KEY);
      expect(stringify(value)).not.toContain(TEST_PRIVATE_KEY.slice(2));
    }
    expect(status.operatorAddress).toBe(TEST_PRIVATE_KEY_ADDRESS);
    expect(status.armState).toBe('armed');
  });

  it('never puts the key in a thrown error message', () => {
    // A malformed key is usually a REAL key with a typo. The value must not be
    // echoed, in the message, the stack, or any property of the error.
    const malformed = `${TEST_PRIVATE_KEY}zz`;
    let thrown: unknown;
    try {
      readOperatorPrivateKey({ LP_OPERATOR_PRIVATE_KEY: malformed });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SignerConfigError);
    const error = thrown as Error;
    expect(error.message).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(error.message).toContain('value withheld');
    expect(error.stack ?? '').not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(stringify({ ...error, message: error.message })).not.toContain(TEST_PRIVATE_KEY.slice(2));
  });

  it('returns a well-formed key unchanged to its single caller', () => {
    expect(readOperatorPrivateKey({ LP_OPERATOR_PRIVATE_KEY: TEST_PRIVATE_KEY })).toBe(TEST_PRIVATE_KEY);
    expect(() => readOperatorPrivateKey({})).toThrow(SignerConfigError);
    expect(() => readOperatorPrivateKey({ LP_OPERATOR_PRIVATE_KEY: '0xdeadbeef' })).toThrow(SignerConfigError);
  });

  it('no exported value of the signer module carries key material', async () => {
    const signerModule = await import('../src/signer/index.js');
    const serialized = Object.entries(signerModule)
      .map(([name, value]) => `${name}:${typeof value === 'function' ? value.name : stringify(value)}`)
      .join('|');
    expect(serialized).not.toContain(TEST_PRIVATE_KEY.slice(2));
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('reports what the chain says, including the fields the interface has no room for', async () => {
    const { signer } = makeSigner({
      armState: 'armed',
      reads: { paused: true, isOperator: false, remainingDailyAllowance: 42n, maxValuePerTx: 7n },
    });

    const status = await signer.getStatus();

    expect(status).toEqual({
      armState: 'armed',
      operatorAddress: OPERATOR,
      safeAddress: SAFE,
      moduleAddress: MODULE,
      moduleEnabled: true,
      remainingDailyAllowanceWei: 42n,
      chainId: ROBINHOOD_CHAIN_ID,
      paused: true,
      operatorAuthorized: false,
      safeMatchesConfig: true,
      maxValuePerTxWei: 7n,
      onChainSafeAddress: SAFE,
    });
  });

  it('flags a module pointed at a different Safe', async () => {
    const { signer } = makeSigner({ reads: { safe: '0x8888888888888888888888888888888888888888' } });
    const status = await signer.getStatus();
    expect(status.safeMatchesConfig).toBe(false);
    expect(status.onChainSafeAddress).toBe('0x8888888888888888888888888888888888888888');
  });
});

// ---------------------------------------------------------------------------
// The ladder itself
// ---------------------------------------------------------------------------

describe('PREFLIGHT_ORDER', () => {
  it('matches the order documented on the TransactionSigner interface', () => {
    expect(PREFLIGHT_ORDER).toEqual([
      'arm_check',
      'module_enabled',
      'destination_allowlist',
      'selector_allowlist',
      'value_cap',
      'daily_allowance',
      'simulation',
      'broadcast',
    ]);
  });
});
