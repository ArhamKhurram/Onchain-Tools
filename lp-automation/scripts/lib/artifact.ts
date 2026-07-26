// Reading the compiled OctAutomationModule from Foundry's build output.
//
// The bytecode is NOT vendored into this repo as a hex blob. A blob nobody can
// diff is a blob nobody reviews, and "the bytecode in the script" and "the
// Solidity in contracts/src" would drift apart with nothing to catch it. So the
// deploy script requires that YOU ran `forge build` on the source you are
// looking at, and it reads what that produced.
//
// The tradeoff is that `deployModule.ts` needs Foundry installed while the
// read-only scripts do not. That is the right way round: the machine that
// deploys is the one that should be able to compile.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WORKSPACE_ROOT } from './env.js';
import { ArgError } from './args.js';

export const DEFAULT_ARTIFACT_PATH = resolve(
  WORKSPACE_ROOT,
  'contracts',
  'out',
  'OctAutomationModule.sol',
  'OctAutomationModule.json',
);

export interface ModuleArtifact {
  readonly path: string;
  readonly bytecode: `0x${string}`;
  readonly bytecodeLength: number;
  /** Compiler settings recorded by forge, echoed so the human can eyeball them. */
  readonly compiler: {
    readonly version?: string;
    readonly evmVersion?: string;
    readonly optimizer?: string;
  };
  /** Present when the build did not strip metadata; a mismatch risk for verification. */
  readonly warnings: readonly string[];
}

/** Pure: pull creation bytecode + compiler settings out of a parsed forge artifact. */
export function extractArtifact(parsed: unknown, path: string): ModuleArtifact {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ArgError(`Artifact at ${path} is not a JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  const bytecodeNode = root.bytecode;
  if (typeof bytecodeNode !== 'object' || bytecodeNode === null) {
    throw new ArgError(`Artifact at ${path} has no "bytecode" section — is it a Foundry artifact?`);
  }
  const object = (bytecodeNode as Record<string, unknown>).object;
  if (typeof object !== 'string') {
    throw new ArgError(`Artifact at ${path} has no usable bytecode.object`);
  }
  // Checked BEFORE the hex test: a placeholder is not valid hex, and reporting
  // "not hex" for an unlinked library would send the reader looking in entirely
  // the wrong direction.
  if (/__\$[0-9a-fA-F]{34}\$__/.test(object) || object.includes('__$')) {
    throw new ArgError(`Artifact at ${path} contains an unlinked library placeholder. Refusing to deploy.`);
  }
  if (!/^0x[0-9a-fA-F]*$/.test(object)) {
    throw new ArgError(`Artifact at ${path} has no usable bytecode.object`);
  }
  if (object.length <= 2) {
    throw new ArgError(
      `Artifact at ${path} has EMPTY bytecode. That happens when the contract is abstract or the ` +
        'build failed. Re-run `forge build` and check its output.',
    );
  }
  // A link reference means the bytecode contains an unresolved library
  // placeholder and would deploy as garbage. OctAutomationModule has no
  // libraries, so this should never fire — which is exactly why it is checked.
  const linkRefs = (bytecodeNode as Record<string, unknown>).linkReferences;
  const warnings: string[] = [];
  if (linkRefs !== undefined && typeof linkRefs === 'object' && linkRefs !== null) {
    if (Object.keys(linkRefs as Record<string, unknown>).length > 0) {
      throw new ArgError(
        `Artifact at ${path} has unresolved library link references. Refusing to deploy placeholder bytecode.`,
      );
    }
  }
  const metadata = root.metadata as Record<string, unknown> | undefined;
  const settings = metadata?.settings as Record<string, unknown> | undefined;
  const optimizer = settings?.optimizer as Record<string, unknown> | undefined;

  const compiler = {
    version: (metadata?.compiler as Record<string, unknown> | undefined)?.version as string | undefined,
    evmVersion: settings?.evmVersion as string | undefined,
    optimizer:
      optimizer === undefined
        ? undefined
        : `${optimizer.enabled === true ? 'enabled' : 'disabled'}, runs=${String(optimizer.runs ?? '?')}`,
  };

  if (compiler.evmVersion !== undefined && compiler.evmVersion !== 'shanghai') {
    warnings.push(
      `Artifact was compiled for evmVersion="${compiler.evmVersion}", but foundry.toml pins "shanghai". ` +
        'Confirm the target chain supports it before deploying.',
    );
  }

  return {
    path,
    bytecode: object as `0x${string}`,
    bytecodeLength: (object.length - 2) / 2,
    compiler,
    warnings,
  };
}

/** Read and validate the artifact from disk. */
export async function loadModuleArtifact(path = DEFAULT_ARTIFACT_PATH): Promise<ModuleArtifact> {
  let body: string;
  try {
    body = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ArgError(
        `No compiled artifact at:\n  ${path}\n\n` +
          'Build it first (Foundry required):\n' +
          '  cd lp-automation/contracts\n' +
          '  git clone --depth 1 --branch v1.9.6 https://github.com/foundry-rs/forge-std lib/forge-std\n' +
          '  forge build\n' +
          '  forge test -vvv        # do not deploy on a red test run\n\n' +
          'The bytecode is read from your own build on purpose — this repo ships no pre-compiled blob.',
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ArgError(`Artifact at ${path} is not valid JSON`);
  }
  return extractArtifact(parsed, path);
}
