import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const jobs = [
  { name: 'backend', args: ['run', 'dev:backend'] },
  { name: 'frontend', args: ['run', 'dev:frontend'] },
  { name: 'landing', args: ['run', 'dev:landing'] },
];

console.log('\n  OCT local dev');
console.log('  ─────────────────────────────────────');
console.log('  Open → http://localhost:5174');
console.log('  Console → http://localhost:5174/dashboard');
console.log('  ─────────────────────────────────────\n');

const children = jobs.map(({ name, args }) => {
  const child = spawn(npm, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[dev] ${name} exited with ${code}`);
  });
  return child;
});

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
