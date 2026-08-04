// Utility: block until N pools have finished backfilling (meta.json files).
// node src/wait-progress.js 12
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWAP_DIR = path.resolve(HERE, '../data/swaps');
const target = Number(process.argv[2] || 12);

for (;;) {
  const n = fs.existsSync(SWAP_DIR)
    ? fs.readdirSync(SWAP_DIR).filter((f) => f.endsWith('.meta.json')).length
    : 0;
  if (n >= target) {
    console.log(`${n} pools backfilled (target ${target})`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
