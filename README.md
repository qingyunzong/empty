# eco-merge

Merge offline quadrant (样方) correction histories collected on multiple
tablets and decide whether the concurrent history converges to a single
species abundance matrix — or pinpoint the earliest causal cycle that makes
it unmergeable. Node.js 22, standard library only, tests via `node:test`.

## Usage

```
node bin/eco-merge.js --config config.json [--budget N] historyA.jsonl historyB.jsonl ...
```

Exit codes: `0` decided (CONCURRENT_OK / LINEARIZABLE_MODEL), `2`
INVALID_HISTORY, `6` CONFLICT, `4` PENDING. The verdict is printed to stdout
as JSON.

## Model

- **Finite domains** (`config.json`): species (each with a morphology class),
  plots (each with an `area` carrying capacity in abundance units), and an
  abundance tier range `[0, maxTier]`.
- **Operations** (one JSON object per line, per-device `ts` strictly
  increasing):
  - `set_count {plot, species, tier}` — set the abundance tier of a cell.
  - `move_plot {plot, from, to, count}` — transfer abundance between species
    within a plot; total abundance in the plot is conserved (source must hold
    at least `count`).
  - `morph_species {from, to}` — global species rename (morphology classes
    must match). Propagates to every history: ops that happen-after the morph
    see the new name. Already-synced facts are never rewritten.
  - `sync {with, mark}` — rendezvous with a peer device; the matching pair
    (same mark, opposite directions) creates happens-before edges in both
    directions across the rendezvous point.
  - `undo_op {target}` — retracts the latest still-unsynced op on the same
    device (stack discipline); undoing a synced op is INVALID_HISTORY.
- **Constraints**: plot area carrying capacity, species morphology
  compatibility, total-abundance conservation for moves, monotonic
  per-device time.

## Verdicts

- `LINEARIZABLE_MODEL` — happens-before (same-device order + sync edges) is
  acyclic and totally orders all writes; the merged matrix equals a legal
  serialization.
- `CONCURRENT_OK` — concurrent writes exist but none interfere; every legal
  serialization converges to the reported matrix.
- `CONFLICT` — a causal cycle (the minimal cycle is reported) or concurrent
  interfering writes (e.g. different tiers for the same cell).
- `PENDING` — the cycle-detection/topology budget was exhausted; no conflict
  is claimed either way.

## Development

```
npm test   # node --test
```
