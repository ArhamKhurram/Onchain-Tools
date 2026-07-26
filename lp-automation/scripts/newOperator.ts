// Generate the automation's operator hot key.
//
// The private key is written straight into `.env` and is NEVER printed, logged,
// returned, or passed through another process. The operator running this only
// ever sees the ADDRESS. That is deliberate: a key that is displayed ends up in
// a scrollback buffer, a screenshot, or a chat transcript, and a key that has
// been displayed should be treated as compromised.
//
// What this key is (LP_AUTOMATION_PLAN.md §4, §9 point 3):
//   - It is NOT a Safe owner. It cannot change the module's limits, cannot add
//     owners, cannot touch the Safe directly.
//   - It can only call the module's allowlisted destinations with allowlisted
//     selectors, within the on-chain caps.
//   - Its compromise is bounded by what those two contracts can reach — which
//     includes withdrawal, because one selector covers compound/adjust/withdraw
//     (plan §11 item 5). Fund the Safe accordingly.
//
// It must be a FRESH wallet holding nothing but gas. Never reuse a wallet with
// unrelated funds.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const ENV_PATH = resolve(process.cwd(), '.env');
const KEY_VAR = 'LP_OPERATOR_PRIVATE_KEY';
const ADDR_VAR = 'LP_OPERATOR_ADDRESS';

function readEnv(): string {
  return existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
}

/** Current value of `name`, or '' if unset/blank. Exported for tests. */
export function readVar(body: string, name: string): string {
  const match = body.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

/**
 * Set `name` to `value`, replacing an existing assignment in place or appending
 * one. Pure so the substitution can be tested without touching a real .env —
 * a bug here would silently drop the operator's other settings.
 */
export function upsertVar(body: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (pattern.test(body)) return body.replace(pattern, line);
  return body.endsWith('\n') || body === '' ? `${body}${line}\n` : `${body}\n${line}\n`;
}

function main(): void {
  const force = process.argv.includes('--force');
  const body = readEnv();
  const existingKey = readVar(body, KEY_VAR);
  const existingAddr = readVar(body, ADDR_VAR);

  // Overwriting a live operator key orphans whatever it holds and silently
  // de-authorizes the running automation (the module still lists the OLD
  // address as its operator). Refuse by default.
  if (existingKey && !force) {
    console.error(
      `\n${KEY_VAR} is already set in ${ENV_PATH}.\n` +
        (existingAddr ? `  Current operator address: ${existingAddr}\n` : '') +
        '\nRefusing to overwrite. If you replace this key you must also:\n' +
        "  1. drain any funds it holds, and\n" +
        '  2. run an owner-signed setOperator() to authorize the new address\n' +
        '     and revoke the old one — otherwise the module still trusts the old\n' +
        '     key and does not trust the new one.\n' +
        '\nRe-run with --force only after reading the above.\n',
    );
    process.exit(1);
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  let next = upsertVar(body, KEY_VAR, privateKey);
  next = upsertVar(next, ADDR_VAR, account.address);
  writeFileSync(ENV_PATH, next, { encoding: 'utf8', mode: 0o600 });

  // The address, and only the address.
  console.log(`
  Operator wallet generated.

    Address:  ${account.address}

  The private key was written to ${ENV_PATH} and deliberately NOT shown here.
  Do not open that file to copy the key anywhere. Do not paste it into a chat,
  an issue, or a commit. .env is gitignored.

  Next:
    1. Send a SMALL amount of gas to the address above. Nothing else — this
       wallet holds gas, never position value.
    2. This address is NOT a Safe owner and must never become one.
    3. It becomes authorized only when you run an owner-signed setOperator()
       (emitted by: npm run tx:allowlist).

  Backup: if you lose this .env you lose the key. That is survivable — generate
  a new one and re-run setOperator(). It is not a wallet worth recovering, and
  that is the point.
`);
}

// Only run when invoked directly, so the pure helpers above stay importable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
  main();
}

export { main };
