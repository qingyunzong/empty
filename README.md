# Two-Replica KV Anti-Entropy

Keys are integers in `[0, 255]`; values carry version vectors. The key
space is split into 16 equal-width buckets. Reconciliation locates
missing, stale, and concurrent-conflict keys with digest-first,
per-key-fallback rounds — never a full exchange unless degenerate.

## Semantics

- `digest(bucket)`: `0` for an empty bucket, otherwise a SHA-256 chain
  folded over entries sorted by key. Bucket summaries also carry
  `count` and `xork` so a digest collision still falls back to
  per-key resolution.
- `reconcile(a, b)`: emits a plan with `pull` / `push` / `conflict`.
  Round 1 exchanges 16 bucket summaries; only differing buckets pay
  per-key exchanges, so message count is monotone in bucket diffs.
- Comparable versions: the newer one wins. Concurrent versions go to
  `conflict` and no winner is chosen automatically.
- Limits: at most 32 keys per round, at most 8 rounds. If keys remain,
  the plan is `INCOMPLETE` and keeps the safely resolved prefix
  (`pending` lists the rest).
- After `apply`, non-conflicted visible state is equal on both replicas
  and both conflict lists are identical.

## CLI (JSON lines, errors exit 5)

```sh
python3 kv.py seed a.json --replica A --keys 20 --seed 1
python3 kv.py put a.json --replica A --key 7 --value hello
python3 kv.py digest a.json [--bucket 0]
python3 kv.py reconcile a.json b.json > plan.json
python3 kv.py apply a.json b.json plan.json   # or "-" for stdin
```

## Tests

```sh
python3 -m unittest discover -s tests -v
```
