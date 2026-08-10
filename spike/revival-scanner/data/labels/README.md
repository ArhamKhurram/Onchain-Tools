# Labeled-token snapshots (operator intake)

**Why these files exist:** minute-resolution candles expire from the public
keyless APIs (GeckoTerminal keeps ~a few days of 1m OHLCV) — so when the
operator labels a token ("this revived", "this faded and died"), the evidence
must be captured **at label time** or it is gone forever. These snapshots are
therefore committed, not gitignored, unlike everything else under `data/`.

**Intake path** (the operator keeps sending mints; run this per mint):

```sh
node src/intake.js <mint> --label <revival|non-revival|fader> [--note "..."]
```

Labels:

- `revival` — dormant/faded token that re-ignited (the target event)
- `non-revival` — dormancy exit that went nowhere (control)
- `fader` — declining-but-never-flatlined archetype (MANLET-class); these are
  the cases the absolute dormancy gate mishandles

Each snapshot dir is `<symbol>-<mint-prefix8>-<YYYYMMDD>/` and contains:

| File | Contents |
| --- | --- |
| `label.json` | mint, symbol, label, note, capture timestamps, top pools, DexScreener summary (incl. `solUsd` for unit conversion) |
| `pools.json` | raw GeckoTerminal pools response for the mint |
| `dexscreener.json` | raw DexScreener token response |
| `minute-<pool>.json` | 1m OHLCV (USD), paged back ~3.5 days, ascending, deduped |
| `hour-<pool>.json` | 1h OHLCV (USD), up to 500 candles (~20 days), ascending |

Re-running intake for the same mint refreshes candles into the existing dir
(matched on the mint prefix) — it does not create duplicates.

Downstream: `src/labels-to-corpus.js` converts these snapshots into
episode-format rows for the trainer (`data/corpus/`).
