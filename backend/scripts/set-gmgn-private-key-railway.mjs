/** Push GMGN_PRIVATE_KEY from gmgn_private.pem to linked Railway service. */
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pemPath = resolve(root, 'gmgn_private.pem');
const railwayCmd =
  process.platform === 'win32'
    ? 'C:\\Users\\PC\\AppData\\Roaming\\npm\\railway.cmd'
    : 'railway';

if (!existsSync(pemPath)) {
  console.error(`Missing ${pemPath} — generate with Node crypto first.`);
  process.exit(1);
}

const pem = readFileSync(pemPath, 'utf8').trim();
const escaped = pem.replace(/\r?\n/g, '\\n');

const apiKey = process.argv[2]?.trim();
if (apiKey) {
  execFileSync(railwayCmd, ['variables', '--set', `GMGN_API_KEY=${apiKey}`], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log('Set GMGN_API_KEY on Railway.');
}

execFileSync(railwayCmd, ['variables', '--set', `GMGN_PRIVATE_KEY=${escaped}`], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

console.log('Set GMGN_PRIVATE_KEY on Railway (value not printed).');
