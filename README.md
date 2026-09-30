# vcmerge

Deterministic merge of two JSON document replicas under vector-clock partial
order. No wall-clock tie-breaking: convergence follows from the merge being a
join-semilattice (commutative, associative, idempotent).

## Document format

A document is a JSON object mapping keys to entries:

```json
{
  "k": {
    "value": "alpha",
    "clock": {"A": 1},
    "tombstone": false,
    "origin": "A",
    "conflict": true,
    "versions": [
      {"value": "alpha", "clock": {"B": 1}, "tombstone": false, "origin": "B"},
      {"value": "beta", "clock": {"A": 1}, "tombstone": false, "origin": "A"}
    ]
  }
}
```

`versions` is the source of truth: the set of causally maximal concurrent
updates. `value`, `clock`, `tombstone`, `origin` and `conflict` are derived
deterministically from it. Input documents may omit `versions` and `conflict`
(the entry itself is then the single version).

## Merge semantics

- Comparable clocks: the newer entry wins; missing clock entries count as 0.
- Concurrent non-delete updates: the value with the smaller canonical JSON
  serialisation is kept and the entry is marked `"conflict": true`.
- Delete concurrent with update: the delete wins. Tombstones are retained in
  the output (never garbage-collected, which satisfies the requirement that
  they live at least until both replicas' clocks are known by the peer);
  only a causally newer update revives the key.

## CLI

```
python -m vcmerge merge LEFT RIGHT --out OUT
```

Writes the canonical merged JSON (sorted keys, compact separators) to `OUT`
and prints the number of conflicted entries to stdout. Errors go to stderr.

Exit codes: `0` success, `2` IO/JSON/structure errors, `3` negative clock
counter.

## Tests

```
python -m unittest discover -s tests -v
```
