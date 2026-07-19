import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
const landingDist = path.join(root, 'landing', 'dist');
const frontendDist = path.join(root, 'frontend', 'dist');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

if (!fs.existsSync(landingDist)) {
  throw new Error('Missing landing/dist — run build -w landing first.');
}
if (!fs.existsSync(frontendDist)) {
  throw new Error('Missing frontend/dist — run build -w frontend first.');
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

copyDir(landingDist, out);
copyDir(frontendDist, path.join(out, 'dashboard'));

console.log('Merged landing → dist/ and frontend → dist/dashboard/');
