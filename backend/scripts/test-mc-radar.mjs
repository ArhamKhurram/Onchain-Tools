import { parseRickEmbeds, parseFooterCallMc } from '../src/utils/rickEmbedParser.ts';

const MELON = '9AwZKiUicugQ7hNdoKJEmV1psybm7yQMMsBb4hTnpump';

const embeds = [{
  title: 'Melon Dog [816K/1.7K%] - MELON/SOL',
  description: 'Solana @ Pump\nFDV: 816K -> 816K [now!]\nLiq: 34.2K\nVol: 296K\nAge: 32m',
  footer: { text: 'jace444444 @ 341.3K 📈 2x - 47s 👀 41' },
}];

console.log('=== Rick parser ===');
console.log('footer:', parseFooterCallMc(embeds.map((e) => [e.title, e.description, e.footer?.text].join('\n')).join('\n')));

for (const caller of ['jace', 'jace444444', undefined]) {
  const r = parseRickEmbeds(embeds, 'Rick', { addressOverride: MELON, callerName: caller });
  console.log(`caller=${caller ?? 'none'} ->`, r?.fdvAtCall, r?.fdvAtCallDisplay, r?.tokenSymbol);
}

console.log('\n=== Dex live ===');
const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${MELON}`);
const data = await res.json();
const pairs = (data.pairs ?? []).filter((p) => p.baseToken?.address === MELON);
pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
const mc = pairs[0]?.fdv ?? pairs[0]?.marketCap;
console.log('Dex MC:', mc, `(${(mc / 1e6).toFixed(2)}M)`);

console.log('\n=== buildRadar simulation ===');
function buildRadar(contracts) {
  const map = new Map();
  for (const c of contracts) {
    const key = c.address.toLowerCase();
    const ts = new Date(c.timestamp).getTime();
    let row = map.get(key);
    if (!row) {
      row = {
        address: c.address,
        mcAtCall: c.fdvAtCall,
        mcAtCallDisplay: c.fdvAtCallDisplay,
        firstSeenAt: ts,
      };
      map.set(key, row);
    }
    if (ts < row.firstSeenAt) {
      row.firstSeenAt = ts;
      row.mcAtCall = c.fdvAtCall ?? row.mcAtCall;
      row.mcAtCallDisplay = c.fdvAtCallDisplay ?? row.mcAtCallDisplay;
    }
  }
  return [...map.values()];
}

// Scenario: rescan first in array (newest), first scan second, first scan has Rick 341K
const contracts = [
  { address: MELON, timestamp: '2026-07-21T06:30:00Z', fdvAtCall: 1091958, fdvAtCallDisplay: '1.1M' },
  { address: MELON, timestamp: '2026-07-21T06:15:00Z', fdvAtCall: 341300, fdvAtCallDisplay: '341.3K' },
];
console.log('Two rows (rescan 1.1M, first 341K):', buildRadar(contracts));

// Scenario: first scan null fdv, hydrated from catalog as 1.1M
const contracts2 = [
  { address: MELON, timestamp: '2026-07-21T06:30:00Z', fdvAtCall: 1091958, fdvAtCallDisplay: '1.1M' },
  { address: MELON, timestamp: '2026-07-21T06:15:00Z', fdvAtCall: undefined, fdvAtCallDisplay: undefined },
];
console.log('Earliest null fdv (bug):', buildRadar(contracts2));
