# recon-recompute

Layered reconciliation recompute engine (Node.js 22 stdlib only, tests via `node:test`).
Generates a corrected view from `confirmed.jsonl` + `deltas.jsonl` with rollback at
day / merchant / transaction level, without mutating confirmed snapshots.

## CLI

```
node cli.js recon --base c.jsonl --deltas d.jsonl --rollback day:2024-01-01[@version] [--out versions.jsonl]
```

- `--base` confirmed snapshots (required)
- `--deltas` corrections (optional)
- `--rollback` repeatable, format `level:target[@version]` (default version: base v1)
- `--out` output file (default `versions.jsonl`)
- Exit code `6`: cyclic parent chain in base snapshots; `2`: bad arguments

## Input formats

`confirmed.jsonl` — one snapshot per line:

```json
{"level":"day|mch|txn","target":"2024-01-01[/M001[/T001]]","amount":1000,"locked":false,"watermark":"2024-01-02T12:00:00Z","version":1,"parent":null}
```

`version`/`parent` are optional (default: single base v1). Explicit chains are
validated; a cycle aborts with exit code 6.

`deltas.jsonl` — one correction per line:

```json
{"scope":"day|mch|txn","target":"2024-01-01/M001","delta":-50,"eventTime":"2024-01-02T00:01:00Z","seq":1}
```

## Semantics

- Deltas apply to the most recent **unlocked** snapshot and always create a **new
  version**; locked snapshots are read-only and their deltas go to `pending`.
- Watermark: a delta enters the current recompute only when `eventTime <= watermark`
  (targets without a watermark admit everything); later deltas stay `pending`.
- Concurrent deltas on the same target are ordered by `(eventTime, seq)`; equal keys
  are **all** applied and marked `TIE` — never randomly picked.
- `rollback(day)` cascades to its mch/txn descendants (back to base v1);
  `rollback(mch)` cascades to its txns; `rollback(txn)` never touches siblings.
- Rollback to a missing target/version records `NO_VERSION`.

## Output

`versions.jsonl`, one record per line:

```json
{"level":"mch","target":"2024-01-01/M001","version":2,"parent":1,"amount":550,"status":"applied"}
```

`status`: `confirmed` | `applied` | `TIE` | `rolledback` | `pending` | `NO_VERSION`.

## Tests

```
node --test
```

Covers: A) three-level rollback restores the original snapshot, B) locked → pending,
C) tied deltas all emitted as `TIE`, D) scope-combination enumeration within an
80-delta budget cross-checked against rollback, plus `NO_VERSION` and cycle exit 6.
