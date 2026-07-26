// Public surface of the signing layer.
//
// `lifecycle/` should import `TransactionSigner` from `./types.js` and nothing
// else from here except the factory. The concrete class, the clients, and the
// ABI are exported for tests and for operational tooling (a status command),
// not as an invitation to reach around the interface.

export type {
  ArmState,
  PreflightStage,
  SignerStatus,
  SubmitOutcome,
  SubmitRequest,
  TransactionSigner,
} from './types.js';

export { OCT_AUTOMATION_MODULE_ABI, type OctAutomationModuleAbi } from './abi.js';
export {
  ARM_ENV_VAR,
  SignerConfigError,
  loadSignerConfig,
  parseArmState,
  parseSignerConfig,
  readOperatorPrivateKey,
  type SignerConfig,
} from './config.js';
export {
  createModuleClients,
  resolveSimulationAccount,
  type ContractReadRequest,
  type ContractSimulateRequest,
  type ModuleClients,
  type SignerPublicClient,
  type SignerWalletClient,
} from './clients.js';
export {
  ModuleTransactionSigner,
  PREFLIGHT_ORDER,
  SignerReadError,
  describeError,
  type ModuleSignerStatus,
  type ModuleSubmitOutcome,
  type ModuleTransactionSignerDeps,
  type PreflightRejection,
} from './moduleSigner.js';

import { createModuleClients } from './clients.js';
import { loadSignerConfig, readOperatorPrivateKey } from './config.js';
import { ModuleTransactionSigner } from './moduleSigner.js';

/**
 * Build the real signer from the environment.
 *
 * The key's entire lifetime is the two statements below: read from env, handed
 * to `createModuleClients`, out of scope. It is never assigned to a field,
 * never returned, and never logged. `loadSignerConfig` deliberately produces a
 * config object that has no place to put it.
 *
 * Defaults to DISARMED. Arming requires `LP_ARMED=true` exactly — see
 * `parseArmState`. Deploying and arming are two separate decisions on purpose.
 */
export function createSignerFromEnv(env: NodeJS.ProcessEnv = process.env): ModuleTransactionSigner {
  const config = loadSignerConfig(env);
  const { publicClient, walletClient, operatorAddress } = createModuleClients({
    rpcUrl: config.rpcUrl,
    privateKey: readOperatorPrivateKey(env),
  });

  return new ModuleTransactionSigner({ config, publicClient, walletClient, operatorAddress });
}
