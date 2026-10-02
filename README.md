# settle-net

Multilateral settlement netting with correction chunks. Node.js 22, standard
library only (`node:test` for tests).

## Model

- Participants submit transfers (`id:from:to:amount`). Each batch is settled
  by netting: the system picks the **maximum-cardinality subset** of candidate
  transfers such that every participant's net outflow stays within budget
  (budget = per-participant net debit cap). Ties are broken by the
  **lexicographically smallest transfer-id sequence**. The reference selector
  enumerates all subsets of at most 10 transfers.
- Each finalized batch produces an immutable **chunk** containing: level,
  parent result hash, CRC32, delta debits/credits per participant, and index
  entries (the ancestor path). Chunk hash = SHA-256 of the canonical JSON.
- **Correction** of a finalized batch cascades rollback only to chunks that
  explicitly depend on it (descendants via `parentHash`); unrelated nodes stay
  final. The corrected result is re-selected under the **reserved budget**
  (budget minus net outflow already committed by the parent chain).
- **Crash recovery**: if a chunk was persisted but the level index was not
  updated, the index is rebuilt from the chunk chain on load. Chunks whose
  parent reference cannot be resolved stay `missing` and are never treated as
  settleable.

## CLI

```
node bin/settle.js [--data DIR] <command> [options]
```

- `propose --batch B --transfer id:from:to:amount ... --budget P:amt ...`
- `finalize --batch B [--parent B0]` (default parent: current head)
- `correct --batch B --transfer ... --budget ...`
- `rollback --batch B`
- `verify` — prints `OK`, `CORRUPT ...`, or `MISSING ...`
- `state` — lists chunks with status and net positions

Data directory defaults to `$SETTLE_HOME` or `./.settle`.

Exit codes: `0` success, `1` business conflict, `2` corruption.

## Tests

```
node --test > result.txt 2>&1; echo $? >> result.txt
```
