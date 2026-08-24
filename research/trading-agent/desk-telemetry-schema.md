# Desk telemetry contract

The single JSON contract between the **population trainer** (producer) and the
**desk-console visualization** (consumer). One file describes one training run
of a population of agents evolving across generations/epochs. The visualization
renders each *desk* as an archetype niche and animates the timeline of
generations; the trainer emits one `generations[]` entry per epoch it reports.

This is a **visualization/telemetry** artifact — it never feeds training and
carries no reward signal. Numbers are honest read-outs of a real population run.

## Top level

```jsonc
{
  "desk_type": "memecoin",           // "memecoin" | "equities" — which role vocabulary
  "run_id": "pbt-2026-08-23-seed0",  // stable id for this run
  "algo": "pbt",                     // "pbt" (now) | "map_elites" (later)
  "roles": ["GOBLIN","GREMLIN","GIZMO","NOODLE","PICKLE","GECKO"],  // the archetype niches, display order
  "cost_bps": 125,                   // the cost model all pnl_bps are net of
  "generations": [ Generation, ... ] // one per reported epoch, oldest first
}
```

`desk_type: "equities"` uses roles `["TAPE","QUANT","MACRO","RISK","FLOW","PM"]`
(the traditional-floor vocabulary). Same schema, different labels — the viz keys
off `roles`.

**Role names are deliberately goofy codenames, NOT functional descriptions.** The
old functional names (SNIPER/SCAN/WHALE/RUG/SHILL/EXIT) misled — "RUG" read as
"rug-checker" when it's just a niche label. The names carry no behavioral meaning;
the behavior is defined entirely by the descriptor grid cell the name maps to.
Canonical memecoin mapping (descriptor grid: trade_frequency × mean_hold_secs),
**preserve this cell→name assignment** so runs stay comparable:

| hold \ freq | LOW | MED | HIGH |
| --- | --- | --- | --- |
| SHORT (<90s) | GREMLIN | GECKO | GOBLIN |
| LONG (≥90s)  | GIZMO   | PICKLE | NOODLE |

(Non-traders → GREMLIN.) So a GOBLIN is "short-hold, high-frequency" under the hood;
a NOODLE is "long-hold, high-frequency" — but nothing in the UI implies a function.

## Generation (one epoch)

```jsonc
{
  "gen": 0,                     // epoch index, 0-based
  "population_size": 48,        // live agents this generation
  "coverage": 0.50,             // fraction of role-niches with >=1 agent (0..1)
  "best_pnl_bps": 12.0,         // best single agent, net of cost_bps, on held-out tokens
  "mean_pnl_bps": -30.0,        // population mean (usually negative early — honest)
  "desks": [ Desk, ... ]        // exactly one per role in `roles` (occupancy 0 allowed)
}
```

## Desk (one archetype niche within one generation)

```jsonc
{
  "role": "SNIPER",
  "occupancy": 9,               // agents whose behavioral descriptor falls in this niche
  "median_pnl_bps": -5.0,       // median over occupants (null if occupancy 0)
  "champion": Champion | null,  // best occupant (null if occupancy 0)
  "events": ["sniped the mint · 2 SOL", "bans loaded"]  // 0..4 short feed lines
}
```

## Champion (the niche's best agent)

```jsonc
{
  "agent_id": "a0231",
  "pnl_bps": 63.0,              // net of cost_bps, held-out tokens
  "trades": 47,                 // trade count over the eval
  "win_rate": 0.65,            // 0..1
  "hold_secs": 18,             // mean holding time — a behavioral descriptor
  "status": "at the energy bar" // short flavor string for the sprite
}
```

## Archetype assignment (trainer's responsibility)

Each agent gets a **behavioral descriptor** computed from its eval behavior — at
minimum `(trade_frequency, mean_hold_duration)`, optionally entry-latency and
flow-following. The trainer bins the descriptor into one of the `roles` niches
(MAP-Elites style) so `occupancy` and `champion` are well-defined. For the first
PBT pass a threshold/rule mapping is fine; document it. The niche a champion sits
in must be derived from behavior, never hand-assigned.

## Scale note

A real run may hold tens of thousands of agents. The file must NOT enumerate all
of them — it carries only per-niche **aggregates** (occupancy counts + one
champion per niche per generation). That aggregation is what keeps the contract
O(roles × generations), not O(agents), and is exactly what the viz renders.
