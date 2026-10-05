# undo-chain-ledger

Account operations with inverse-op undo chains. Node.js 22, standard library
only, tests via `node:test`. Single-machine, offline.

## Usage

```sh
node cli.js exec ops.jsonl --budget day=1000
node --test
```

Input is JSONL, one op per line. Output is one JSON object per processed line:
`{step, input, status, error, undoPlan, state, undoDepth}` — the state after
every step plus the undo plan for undo steps (`undoPlan` is `null` otherwise).

## Ops

| op | fields | effect |
| --- | --- | --- |
| `deposit` | `account`, `amount` | `balance += amount`, consumes day budget |
| `withdraw` | `account`, `amount` | `balance -= amount`, needs `balance - frozen >= amount`, consumes budget |
| `transfer` | `from`, `to`, `amount` | moves balance, needs `from` available funds, consumes budget |
| `freeze` | `account`, `amount` | `frozen += amount`, needs available funds |
| `unfreeze` | `account`, `amount` | `frozen -= amount`, needs `frozen >= amount` |
| `batchBegin` | `id?` | opens a batch (auto id `b<n>` when omitted) |
| `batchEnd` | `id?` | commits the open batch |
| `undo` | `batch?` | undoes the stack top, or the named committed batch |

`--budget day=N` sets the daily budget consumed by `deposit`/`withdraw`
/`transfer` amounts and refunded by undoing them. Without the flag there is no
budget limit.

## Invariants

Checked after every step: `balance >= 0`, `frozen >= 0`, `frozen <= balance`,
`budget.day >= 0`. Ops inside a batch are applied eagerly; any violation (or
`INSUFFICIENT` rejection) aborts the whole batch and rolls back to the
batch-begin snapshot — no partial effect. Failed ops outside a batch leave the
state untouched.

## Undo chain

Every committed money op records its inverse (`deposit`↔`withdraw`,
`transfer` reverses direction, `freeze`↔`unfreeze`). A standalone op commits as
a single-op unit; a `batchEnd` commits all buffered ops as one unit. Units form
the undo stack.

- `undo` pops the top unit; `undo {batch:id}` targets a committed batch.
- Cross-batch undo expands to the region `[target .. top]` and is planned as
  one deterministic sequence of inverse ops.
- A plan is an ordering of the region's inverse ops where every prefix state
  satisfies the invariants (reverse commit order is always legal, so a plan
  always exists). Zero-amount inverses are dropped; duplicate sequences are
  deduplicated. Regions with more than 8 inverse ops use the canonical
  reverse-commit order directly.
- If several plans are legal, the unique winner is chosen by: fewest ops, then
  involved accounts lexicographically, then original event time descending
  (undo newer events first). A surviving tie yields `AMBIGUOUS_UNDO` and all
  tied plans are listed; nothing is popped.

## Error codes

- `INSUFFICIENT` — not enough available (`balance - frozen`) or frozen funds.
- `BATCH_NESTING` — `batchBegin` inside an open batch (the outer batch
  continues), `batchEnd` without a batch, mismatched batch id, `undo` inside a
  batch.
- `UNDO_GAP` — undo stack empty, or target batch unknown / already undone.
- `AMBIGUOUS_UNDO` — multiple equally preferred undo plans.
- `INVARIANT` — an invariant would break (e.g. day budget would go negative).
- `INVALID` — malformed op (extra code beyond the spec's five).

## Layout

- `src/engine.js` — the library (`Engine`, plan builder, comparators).
- `cli.js` — JSONL in / JSONL out CLI (`run(argv, io)` is exported for tests).
- `test/` — unit, acceptance (A/B/C/E), enumeration (D), CLI and 50k-op scale
  tests.
- `examples/ops.jsonl` — demo input.

Scale: linear per op; 50k ops run in well under a second (see
`test/perf.test.js`).
