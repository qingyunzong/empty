# batch-genealogy

Batch genealogy DAG with positional phrase index, incremental parent-edge
corrections, time-slice queries and verifiable certificates. Node.js 22,
standard library only.

## Model

- Append-only JSONL event log; record types: `add`, `edge`, `correct`, `delete`.
- `correct` expands into a reverse-compensation pair (`revoke` old edge,
  `add` new edge) stored on the record, so history is preserved and old time
  slices never change.
- Queries accept `--at <ts>` and replay only records with `ts <= ts`; later
  (pending) corrections are ignored, never treated as unsatisfiable.
- Deleting a batch tombstones it; the batch and its descendants are masked
  from query results, but its certificate (with `tombstone: 1`) still proves
  the deletion.
- Each certificate commits to parent hashes (recursive), the note text hash
  and the tombstone bit. Log records form a Merkle tree; `prove` emits an
  inclusion proof.

## Errors

`E_CYCLE` (edge would create a cycle), `E_TIME` (out-of-order timestamp),
`E_PROOF` (proof/certificate verification failure).

## CLI

```sh
node cli.js add-batch B1 --note "pine wood lot" [--ts N] [--log file]
node cli.js add-edge CHILD PARENT [--ts N]
node cli.js correct-edge CHILD OLD_PARENT NEW_PARENT [--ts N]
node cli.js delete-batch B1 [--ts N]
node cli.js ancestors B1 [--at N]
node cli.js descendants B1 [--at N]
node cli.js search --phrase "pine wood" | --near pine,oak --dist 3 [--at N]
node cli.js cert B1 [--at N]
node cli.js prove B1 > proof.json
node cli.js verify-proof proof.json
```

## Tests

```sh
node --test
```
