# undo-ledger

Account operations with an undo chain. Node.js 22, standard library only, tests via `node:test`.

## Ops (JSONL, one per line)

```json
{"op":"deposit","account":"a","amount":100}
{"op":"withdraw","account":"a","amount":50}
{"op":"transfer","from":"a","to":"b","amount":20}
{"op":"freeze","account":"a","amount":10}
{"op":"unfreeze","account":"a","amount":10}
{"op":"batchBegin","id":"B1"}
{"op":"batchEnd"}
{"op":"undo"}
{"op":"undo","batch":"B1"}
```

Optional `ts` (number) sets the event time used by undo-plan tie-breaking;
otherwise a monotonically increasing sequence number is assigned.

## Semantics

- Every committed op/batch pushes an undoable unit; each op has a unique inverse
  (deposit<->withdraw, transfer reversed, freeze<->unfreeze; budget deltas negated).
- `undo` reverts the top undoable unit; `undo --batch <id>` targets a committed
  batch, expanding cross-batch into a deterministic inverse-op sequence validated
  against the current state.
- Invariants after every step: `balance>=0`, `frozen>=0`, `frozen<=balance`,
  day budget `>=0`. A violating step fails the whole batch with no partial effect.
- Undo-plan selection: fewest ops, then involved accounts lexicographic, then
  original event time descending. A remaining tie yields `AMBIGUOUS_UNDO` with
  all tied plans listed.
- Day budget is consumed by `withdraw`/`transfer` (outflows) and restored by undo.

## Error codes

`INSUFFICIENT` (balance would go negative), `INVARIANT` (frozen/budget invariant
violation or no legal undo plan), `BATCH_NESTING` (nested batchBegin, batchEnd
without batch, undo inside a batch), `UNDO_GAP` (nothing/unknown target to undo),
`AMBIGUOUS_UNDO`, plus `INVALID_INPUT` for malformed ops.

## Run

```sh
node cli.js exec ops.jsonl --budget day=1000   # JSONL results on stdout
node --test                                   # run the test suite
```

Each output line: `{step, status, input, error?, state, undoPlan}` where
`undoPlan` previews the plan for the current undoable stack top (or the plan an
`undo` step executed).
