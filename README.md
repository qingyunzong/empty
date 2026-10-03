# ledger

Hash-chained transaction ledger (Node.js 22, standard library only) with a
protected published prefix and crash-safe commits.

## Commands

```
ledger [--dir <path>] init
ledger [--dir <path>] append <tx.json>
ledger [--dir <path>] reverse <txId>
ledger [--dir <path>] rewrite --keep-published <anchorHash> [--drop <txId>...]
ledger [--dir <path>] verify
ledger [--dir <path>] balance
```

The ledger directory defaults to `./.ledger` (or `LEDGER_DIR`).

## Model

- A transaction is `{id, parent, amount, account, kind, payloadHash}` with
  `kind` = `NORMAL` | `REVERSAL`. `parent` is the chain hash of the previous
  transaction (`0`*64 for the first); `append` rejects any other parent.
- Each transaction is stored content-addressed in `txs/<sha256>.json`; `HEAD`
  holds the tip hash. `verify` walks the chain and re-checks every hash.
- `reverse` only appends a compensating `REVERSAL` (negated amount, same
  account); it never touches the published anchor or its ancestors.
- `rewrite` rebuilds the unpublished suffix after `--keep-published`: it may
  drop/reorder unpublished `NORMAL` txs, keeps every `REVERSAL` and its
  causal order, and requires per-account totals to be unchanged.

## Exit codes (errors are JSON on stderr)

| code | meaning                                   |
|------|-------------------------------------------|
| 1    | internal / injected fault                 |
| 2    | invalid input (bad tx, parent mismatch…)  |
| 3    | anchor not found                          |
| 4    | duplicate reversal                        |
| 5    | published hash chain broken / tampered    |
| 6    | rewrite constraints unsatisfiable         |

## Crash safety

Commits write tx files to `*.tmp`, fsync, rename into place, then update
`HEAD` via `HEAD.tmp` + rename (the single atomic commit point). Orphaned
suffix files are removed only after the new head is durable, and leftover
`*.tmp` files are cleaned on the next command. A crash therefore always
leaves either the old chain or the new chain fully intact — never a
half-chain. Set `LEDGER_FAIL_AT=tmp|rename|head` to inject a fault at each
of the three commit stages (used by the tests).

## Tests

```
node --test
```
