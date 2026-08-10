// Replay a labeled snapshot (data/labels/<dir>) through the detector under
// each dormancy mode — the per-case evidence for the relative-dormancy
// experiment (see measure-dormancy.js for the corpus-wide half).
//
//   node src/labels-replay.js <mint|prefix|dir> [--at 2026-08-10T17:38Z]
//
// --at marks the event minute the operator labeled; the report prints the
// detector state there and whether each mode would have alerted within
// +/- 60 min. Gates: only trigger+RVOL is evaluable from OHLCV (no wallet or
// buy/sell data in public candles — see labels-common.js).
import { buildSnapshots, runDetector } from './detector.js';
import { C0, DETECTOR, DORMANCY } from './config.js';
import { loadSnapshot } from './labels-common.js';

const args = process.argv.slice(2);
const ref = args.find((a) => !a.startsWith('--'));
const atArg = (() => {
  const i = args.indexOf('--at');
  return i >= 0 ? args[i + 1] : null;
})();
if (!ref) {
  console.error('usage: node src/labels-replay.js <mint|prefix|dir> [--at ISO_TS]');
  process.exit(1);
}

const MODES = [
  { name: 'absolute', dormancy: { ...DORMANCY, MODE: 'absolute' } },
  ...[0.01, 0.02, 0.05, 0.10, 0.25].map((f) => ({
    name: `relative@${(f * 100).toFixed(0)}%`,
    dormancy: { ...DORMANCY, MODE: 'relative', REL_COLLAPSE_FRAC: f },
  })),
  // two-stage ignitions (stir -> consolidate -> explode) can put the real
  // trigger past the 120-min dormancy lookback; measure a 240-min variant
  { name: 'absolute+LB240', dormancy: { ...DORMANCY, MODE: 'absolute' }, lookback: 240 },
  { name: 'relative@2%+LB240', dormancy: { ...DORMANCY, MODE: 'relative', REL_COLLAPSE_FRAC: 0.02 }, lookback: 240 },
  { name: 'none', dormancy: { ...DORMANCY, MODE: 'none' } },
];
const COMBO = { name: 'trigger+RVOL', rvol: DETECTOR.RVOL_GATE };

const { dir, label, pool, candles } = loadSnapshot(ref);
const atTs = atArg ? Math.floor(Date.parse(atArg) / 1000 / 60) * 60 : null;
console.log(`replay: ${label.symbol} (${label.mint.slice(0, 8)}…) pool=${pool.slice(0, 8)}…`);
console.log(`tape: ${candles.length} min  ${new Date(candles[0].ts * 1000).toISOString()} -> ${new Date(candles[candles.length - 1].ts * 1000).toISOString()}`);
if (atTs) console.log(`event minute: ${new Date(atTs * 1000).toISOString()}`);

for (const m of MODES) {
  const cfg = m.lookback ? { ...DETECTOR, DORMANCY_LOOKBACK_MIN: m.lookback } : DETECTOR;
  const snaps = buildSnapshots(candles, cfg, C0, m.dormancy);
  const alerts = runDetector(snaps, COMBO, cfg);
  let line = `${m.name.padEnd(18)} alerts=${String(alerts.length).padStart(3)}`;
  if (atTs) {
    const at = snaps.find((s) => s.ts === atTs);
    const hit = alerts.find((a) => Math.abs(a.ts - atTs) <= 3600);
    line += `  @event: trigger=${at ? (at.trigger ? 'Y' : 'n') : '?'}` +
      ` z=${at ? at.atrPctZ.toFixed(1) : '?'} rvol=${at ? at.rvol.toFixed(1) : '?'}` +
      ` dormantRecently=${at ? (at.dormantRecently ? 'Y' : 'n') : '?'}` +
      `  ALERT within +/-60min: ${hit ? 'YES @ ' + new Date(hit.ts * 1000).toISOString().slice(11, 16) : 'NO'}`;
  }
  console.log(line);
  if (!atTs) {
    for (const a of alerts.slice(0, 10)) {
      console.log(`    ${new Date(a.ts * 1000).toISOString()} z=${a.atrPctZ.toFixed(1)} rvol=${a.rvol.toFixed(1)}`);
    }
  }
}
