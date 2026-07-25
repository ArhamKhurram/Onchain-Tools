import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const railwayJson = execSync('railway variables --json', {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

const j = JSON.parse(railwayJson);
const secret = '12da3f2930babbf9771d996844c70d4058cd1406b4e167f255728b1b6cdc5cef';

const content = [
  'PORT=3100',
  'HOST=0.0.0.0',
  `FOMO_WORKER_SECRET=${secret}`,
  'FOMO_PROFILE_DIR=/var/lib/fomo-worker/profile',
  `SUPABASE_URL=${j.SUPABASE_URL}`,
  `SUPABASE_SERVICE_KEY=${j.SUPABASE_SERVICE_KEY}`,
  `FOMO_REFRESH_TOKEN=${j.FOMO_REFRESH_TOKEN}`,
  `FOMO_PRIVY_APP_ID=${j.FOMO_PRIVY_APP_ID ?? ''}`,
  `FOMO_PRIVY_CA_ID=${j.FOMO_PRIVY_CA_ID ?? ''}`,
  `FOMO_PRIVY_SESSION=${j.FOMO_PRIVY_SESSION ?? ''}`,
  `FOMO_PRIVY_TOKEN=${j.FOMO_PRIVY_TOKEN ?? ''}`,
  'DEBUG=false',
].join('\n') + '\n';

const tmp = join(tmpdir(), 'fomo-worker.env');
writeFileSync(tmp, content, { mode: 0o600 });

try {
  execSync(`scp -o BatchMode=yes "${tmp}" root@167.179.66.57:/etc/fomo-worker.env`, {
    stdio: 'inherit',
  });
  execSync(
    'ssh -o BatchMode=yes root@167.179.66.57 "chmod 600 /etc/fomo-worker.env && systemctl restart fomo-worker && sleep 8 && curl -s http://127.0.0.1:3100/health && echo && systemctl is-active fomo-worker"',
    { stdio: 'inherit' },
  );
} finally {
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
}

console.log('VPS fomo-worker configured.');
