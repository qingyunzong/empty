# vcmerge

Deterministic merge of two replicas of a JSON document using vector clocks.
No wall-clock tie-breaking: convergence follows purely from causality plus a
deterministic total order.

## Document format

A document is a JSON object mapping keys to entries:

```json
{"k": {"value": "apple", "clock": {"n1": 2, "n2": 1}, "tombstone": false, "origin": "n1"}}
```

Each entry has `value` (any JSON), `clock` (vector clock `{node: counter}`),
`tombstone` (bool) and `origin` (node id). Missing clock entries count as 0.

## CLI

```
python -m vcmerge merge LEFT RIGHT --out OUT
```

* `OUT` receives the merged document as canonical JSON (sorted keys, tight
  separators, trailing newline).
* stdout prints the number of conflicts.
* Errors go to stderr. Exit codes: `0` ok, `1` IO/JSON/validation error,
  `3` negative clock counter.

## Merge semantics

1. Comparable clocks: the strictly newer entry wins.
2. Incomparable clocks, both live values: keep the value with the
   lexicographically smaller canonical JSON serialisation; record a conflict.
3. Delete concurrent with update: the tombstone wins. Tombstones are kept
   until dominated by a strictly newer entry (a conservative realisation of
   "keep at least until both replicas' clocks are known by the other side").
4. The winner is chosen by a deterministic total order that extends the
   causal partial order (clock-sum tier, then tombstone, then canonical
   value, then origin, then canonical clock). This makes the merge
   commutative, associative and idempotent, so every synchronisation order
   converges to the same document.

Note: a naive "incomparable -> smallest value" rule combined with
"comparable -> newer wins" is not associative on reachable replica states
(e.g. values `"a"@{n1:1}`, `"z"@{n1:2}`, `"m"@{n2:1}` diverge depending on
sync order). The total order above coincides with rules 1-3 for
equal-height concurrent writes while remaining associative in general.

## Library

```python
from vcmerge import merge_documents
result = merge_documents(left, right)   # MergeResult(document, conflicts)
```

## Tests

```
python -m unittest discover -s tests -v
```

Covers: exhaustive 3-node event graphs (n <= 3) plus random graphs up to
n = 8 events under all synchronisation orders (convergence), brute-force
commutativity/associativity/idempotency, concurrent-edit conflicts,
tombstone vs late update, byte-identical repeated merges, and CLI behaviour
including exit code 3 for negative counters. Real output is recorded in
`TEST_LOG.txt`.
