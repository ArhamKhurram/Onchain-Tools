// One-off API shape exploration. Prints structures, never credentials.
import { pinaxGet } from './pinax.js';

function summarize(obj, depth = 0) {
  if (depth > 3) return '...';
  if (Array.isArray(obj)) {
    return obj.length ? [summarize(obj[0], depth + 1), `(+${obj.length - 1} more)`] : [];
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = summarize(v, depth + 1);
    return out;
  }
  return obj;
}

const what = process.argv[2] || 'swaps';

if (what === 'networks') {
  const nets = await pinaxGet('/v1/networks', {}, { cache: false });
  console.log(JSON.stringify(nets, null, 2).slice(0, 4000));
} else if (what === 'swaps') {
  const swaps = await pinaxGet('/v1/svm/swaps', { network: 'solana', limit: 2 }, { cache: false });
  console.log(JSON.stringify(summarize(swaps), null, 2));
} else {
  // arbitrary path probe: node src/probe.js path /v1/... key=value...
  const pathname = process.argv[3];
  const params = {};
  for (const kv of process.argv.slice(4)) {
    const [k, ...rest] = kv.split('=');
    params[k] = rest.join('=');
  }
  try {
    const res = await pinaxGet(pathname, params, { cache: false });
    console.log(JSON.stringify(summarize(res), null, 2).slice(0, 6000));
  } catch (e) {
    console.error(String(e).slice(0, 1000));
  }
}
