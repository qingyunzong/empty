# rundiff

Locate the minimal dataset/parameter differences between two experiment runs
and generate replayable diff queries. Node.js 22, standard library only,
offline / single-machine.

## Run directory layout

```
runDir/
  params.json        experiment parameters (any JSON object)
  schema.json        optional: keys, causal deps, tolerance
  data/<table>.csv   datasets
```

`schema.json`:

```json
{
  "tolerance": { "abs": 1e-9, "rel": 1e-9 },
  "tables": {
    "metrics": {
      "key": "id",
      "dependsOn": ["lr", "model.depth"],
      "refs": { "parent_id": "other_table" }
    }
  }
}
```

- `key`: primary key column(s); required for diff/minexplain (`E_NO_KEY`).
- `dependsOn`: parameters that causally influence this table's rows.
- `refs`: column -> table foreign-key references (difference propagation).

## Cell encoding (normalized snapshot)

- `\N` in CSV = NULL; distinct from a missing column (reported separately).
- `?` / `NaN` = unknown. Comparisons involving unknown yield `undecided`
  and are never counted as inconsistencies.
- Floats are canonicalized (`1.0` == `1`, `-0` == `0`); rows are sorted, so
  row order in the CSV never affects the snapshot hash.

## Commands

```
rundiff snap <runDir> [--name n]           build normalized snapshot
rundiff diff <a> <b> [--tol-abs n] [--tol-rel n]
rundiff minexplain <a> <b> [--one]         all minimum explanation sets
rundiff patch <runDir> <change.json>       journaled parameter patch
rundiff recheck                            recover journals, replay last query
```

Store defaults to `./.rundiff` (override with `--store` or `RUNDIFF_STORE`).

- `diff` computes the symmetric diff (only-in-A / only-in-B / changed cells /
  undecided cells / missing columns) and persists it as a replayable query in
  `.rundiff/queries/last.json` (including the full result).
- `minexplain` builds the causal graph (changed parameters + differing rows,
  edges via `dependsOn` and `refs`) and lists *all* minimum-cardinality
  explanation sets. `--one` fails with `E_AMBIG_MIN` when several exist.
- `patch` applies `change.json` (`{"set": {"a.b": 1}, "unset": ["x"]}`) in a
  journaled two-phase write, then updates the snapshot incrementally (table
  index is reused; only params + hash are recomputed). Undoing a change is
  just another patch.
- `recheck` first replays any interrupted patch journals (idempotent crash
  recovery), then re-executes the saved query and prints MATCH (exit 0) or
  MISMATCH (exit 4).

## Error codes

- `E_NO_KEY` — table has no primary key (or key column missing from data).
- `E_TOL` — invalid tolerance (negative, NaN, infinite, non-numeric).
- `E_AMBIG_MIN` — `--one` requested but several tied minimal explanations exist.
- `E_SNAP` — snapshot/query missing or corrupt.

The last error is also written to `.rundiff/last-error.json`.

## Tests

```
node --test
```

Covers: snapshot normalization, float-tolerance boundaries, NULL vs missing
column, undecided handling, minimal explanations cross-checked against
exhaustive subset enumeration (200-row scenario + randomized seeds), tied
minima, journaled patch crash recovery and replay.
