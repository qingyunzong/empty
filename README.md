# kvae — two-replica key/value anti-entropy

Keys are integers in `[0, 255]`; values carry version vectors. The key space
is split into 16 fixed equal-width buckets (16 keys each). A bucket digest is
`0` when empty, otherwise a deterministic SHA-256 fold of `(key, version
vector)` pairs ordered by sorted key.

## Reconciliation

`reconcile` compares bucket digests and exchanges per-key summaries only for
differing buckets (no full-state transfer unless everything degenerates).
Each round exchanges at most 32 key summaries (both directions count); at
most 8 rounds. Comparable versions: the dominating one wins. Concurrent
versions go to `conflict` and are never auto-resolved. If the budget is
exhausted, the plan is `INCOMPLETE` and contains only the safely computed
prefix. After `apply`, both replicas have equal visible state, or identical
conflict lists covering every divergence.

## CLI (JSON lines, errors exit with code 5)

```sh
python -m kvae seed --replica a.json --id A --keys 20 --seed 7
python -m kvae put --replica a.json --key 42 --value '"hello"'
python -m kvae digest --replica a.json [--bucket 3]
python -m kvae reconcile --a a.json --b b.json --plan-out plan.json
python -m kvae apply --a a.json --b b.json --plan plan.json
```

## Tests

```sh
python -m unittest discover -s tests -v
```
