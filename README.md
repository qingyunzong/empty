# snapdiff

Locate the **minimal difference** between two experiment runs (datasets +
parameters) and turn it into a **re-executable diff query**, instead of
eyeballing files. Node.js 22, standard library only, fully offline.

## Run directory layout

```
run/
  params.json     experiment parameters (JSON object)
  schema.json     keys, tolerances, dependencies (see below)
  data/*.csv      relations; "\N" = NULL, ragged-short rows = missing cells
  .snap/          managed by snapdiff: snapshot.json, index.json,
                  journal.jsonl, diffcache.json
```

`schema.json`:

```json
{
  "tables": {
    "metrics": {
      "key": ["id"],
      "types": { "id": "string" },
      "tolerance": { "loss": 1e-9, "score": { "rel": 1e-6 } },
      "refs": { "sample_id": "samples.id" }
    }
  },
  "deps": { "optimizer.lr": ["metrics"], "seed": ["metrics", "samples"] }
}
```

## Commands

```
snapdiff snap <runDir>                 build/refresh the normalized snapshot
snapdiff diff <a> <b>                  symmetric diff (params + relations)
snapdiff minexplain <a> <b>            minimal param-change sets explaining the diff
snapdiff patch <runDir> <change.json>  apply a param change (journaled, crash-safe)
snapdiff recheck <runDir> [other]      replay journal, repair, incremental re-diff
```

All output is JSON on stdout; diagnostics on stderr. Exit codes:

| code | meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | ok / equal / undecided                             |
| 1    | differences found                                  |
| 10   | `E_NO_KEY` missing/invalid primary key             |
| 11   | `E_TOL` invalid or conflicting tolerance           |
| 12   | `E_AMBIG_MIN` several tied minimal explanations    |
| 13   | `E_SNAP` missing/corrupt/stale snapshot or journal |

## Semantics

- **Normalization**: rows sorted by primary key; numbers canonicalized and
  (for row hashes) quantized by the declared absolute tolerance; `\N` encodes
  NULL and is distinct from a *missing* cell/column (`{"$missing": true}`).
- **Three-valued comparison**: a numeric mismatch with a declared tolerance is
  `equal`/`different`; *without* a tolerance it is `undecided` and is never
  reported as an inconsistency (diff status `undecided`, exit 0).
- **Symmetric diff**: per table, rows `only_a` / `only_b` / `changed` (with
  per-cell verdicts) / `undecided`, keyed by the declared primary key.
- **Causal graph**: `param -> rows` edges from `deps` (prefix match) and
  `row -> row` edges from foreign-key `refs`; coverage is reachability.
  `minexplain` returns *all* minimum-size subsets of changed params whose
  coverage covers every differing row (exhaustive up to 24 changed params,
  greedy fallback flagged `exact: false`). Rows unreachable from any changed
  param are listed under `unexplained`.
- **patch / recheck**: `change.json` supports `{"set": {...}, "unset": [...],
  "undo": [...]}` (`undo` restores the pre-patch value from the journal).
  Order: journal append (fsync) -> params.json -> snapshot -> index -> commit.
  A crash before the index update leaves a pending journal entry; `recheck`
  replays it idempotently. `recheck a b` recomputes the pairwise diff
  incrementally, reusing cached per-table results whose hashes are unchanged.

## Tests

```
node --test
```

Covers: minimal explanations vs. exhaustive subset search (200 rows), tied
minima, float tolerance boundaries, NULL vs. missing, and crash recovery
(inject with `SNAPDIFF_CRASH=before-index`).
