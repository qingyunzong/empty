# eco-merge

Merge offline quadrat-sampling histories collected on multiple field tablets
and decide whether concurrent correction histories converge to a single
species-abundance matrix. Pure Node.js 22 standard library; tests use
`node:test`.

## Usage

```sh
node bin/eco-merge.js [--config config.json] [--budget N] devA.jsonl devB.jsonl ...
node --test
```

Verdicts (stdout JSON) and exit codes:

| verdict              | meaning                                             | exit |
|----------------------|-----------------------------------------------------|------|
| `CONCURRENT_OK`      | concurrency exists, but the merge is unambiguous    | 0    |
| `LINEARIZABLE_MODEL` | happens-before totally orders all ops               | 0    |
| `CONFLICT`           | causal cycle / write conflict / constraint violation| 6    |
| `PENDING`            | cycle-detection budget exhausted; no conflict judged| 4    |
| `INVALID_HISTORY`    | malformed input (stderr JSON)                       | 2    |

## History format (JSONL, one op per line, one device per file)

- `set_count` `{plot, species, tier}` — record an abundance tier for a species in a plot.
- `morph_species` `{from, to}` — global species rename. Propagates to every
  history but never rewrites facts already committed by a matched `sync`.
- `move_plot` `{from, to}` — relocate a quadrat's records to another plot id
  (same propagation/freezing rules as `morph_species`).
- `sync` `{session}` — rendezvous: a session must appear exactly twice, on two
  different devices; everything before one sync happens-before everything
  after its counterpart.
- `undo_op` `{target}` — retract an earlier op **on the same device**; only
  allowed while the target has not been synced.

Every op needs `device` and an integer `time` that strictly increases within
its file. Op ids default to `<device>#<line>`.

## Model

1. Parse + validate (JSON shape, finite domains for species/plots/tiers,
   morphology compatibility, monotonic per-device time, undo rules) —
   violations are `INVALID_HISTORY`.
2. Build the happens-before graph: per-device program order plus sync edges.
3. Budget-limited topological sort; on failure, a budget-limited search
   returns the **minimal causal cycle** (`CONFLICT`/`CAUSAL_CYCLE`). Budget
   exhaustion yields `PENDING` — never a conflict verdict.
4. Effective names: renames apply to all unsynced facts across all devices;
   facts committed by an earlier sync are frozen.
5. Per effective (plot, species) cell, the maximal writers must agree and
   must come from a single raw cell, otherwise: `WRITE_CONFLICT` (concurrent
   disagreeing writes) or `CONSERVATION_VIOLATION` (a rename would merge two
   recorded populations, breaking total-count conservation).
6. The merged matrix is checked against plot carrying capacity
   (`area * capacityPerArea`, weighted by `tierWeights`) and morphology
   compatibility; violations are `CONFLICT`.

See `examples/` for a three-device merge and `examples/cycle/` for a causal
cycle. `RESULTS.md` contains real `node --test` and CLI output.
