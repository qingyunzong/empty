# Chargeback Fund-Recovery Ledger

Determines fund-recovery paths for chargebacks that roll liability up a
merchant → store → terminal hierarchy. Node.js 22, standard library only,
tests via `node:test`, fully offline.

## Model

- Nodes form a forest; each node has `id`, `parent` (or `null`), integer
  `balance`, and an optional responsibility `rule`: `"self"` or `"parent"`.
- Rules inherit down the hierarchy: a node without its own rule uses the
  nearest ancestor's rule; the implicit default is `"self"`. A child rule
  overrides the inherited one.
- A node is a **bearer** when its effective rule is `"self"`.

## Chargeback

A chargeback at node `N` walks from `N` up to the root and collects bearers
in order. Each bearer covers `min(balance, remaining)`; if a balance is
insufficient the bearer covers partially and the remainder continues upward.
Every step is recorded as `{node, amount, balanceAfter}`.

- Fully covered → `status: "settled"`, `code: null`.
- Remainder left after the root → `status: "partial"`, `code:
  "E_INSUFFICIENT"`, with `covered` / `uncovered` amounts.

## Reversal (restore)

Reversing a chargeback restores amounts in the reverse of the original
path order (top-most bearer first). Before applying, every step's node
balance is checked against the balance recorded right after the chargeback.
If any layer's balance has changed, the whole restore fails atomically with
`code: "E_RESTORE"` (balances untouched) and the failure is appended to the
chargeback's audit trail. The chargeback keeps its audit history across
failed and successful restores.

## Path enumeration and tie-breaking

`enumerate` computes, for a hypothetical amount, the recovery path of every
node without mutating state. Paths are ordered by:

1. covered amount, descending;
2. occurrence-node depth, ascending (shallower first) — for ties on amount;
3. node id, lexicographic.

## JSONL input format

One operation per line; blank lines are ignored.

```jsonl
{"op":"add_node","id":"m1","parent":null,"balance":1000,"rule":"self"}
{"op":"add_node","id":"s1","parent":"m1","balance":500,"rule":"parent"}
{"op":"add_node","id":"t1","parent":"s1","balance":100}
{"op":"chargeback","id":"cb1","node":"t1","amount":250}
{"op":"adjust","node":"s1","delta":-50}
{"op":"reverse","chargeback":"cb1"}
{"op":"enumerate","amount":100}
```

- `parent`, `balance`, `rule` default to `null`, `0`, `null`.
- `chargeback` requires a unique `id`, an existing `node`, and a positive
  integer `amount`.
- `reverse` restores in reverse path order; fails with `E_RESTORE` if a
  layer's balance changed.
- `adjust` adds `delta` to a node balance (result must stay ≥ 0).
- `enumerate` lists all nodes' hypothetical recovery paths, sorted as above.

## Output

The CLI writes a JSON array with one result per input line, each tagged
with `line`, `op`, `ok`, and per-op fields (`steps`, `restored`, `code`,
`status`, `paths`, ...). Business failures (`E_INSUFFICIENT`, `E_RESTORE`)
are reported inside results with `ok: false`.

Input errors (`E_PARSE`, `E_UNKNOWN_OP`, `E_UNKNOWN_NODE`,
`E_UNKNOWN_CHARGEBACK`, `E_DUPLICATE_NODE`, `E_DUPLICATE_CHARGEBACK`,
`E_INVALID_AMOUNT`, `E_INVALID_RULE`, `E_INVALID_NODE`, `E_BALANCE`,
`E_ALREADY_REVERSED`, `E_IO`) are printed to stderr and exit with code 1;
no result file is written.

## Usage

```sh
node cli.js case.jsonl result.json
node --test
```

Library API: `require('./lib')` exposes `Ledger` (`addNode`, `chargeback`,
`reverse`, `adjust`, `enumerate`, `apply`), `processJsonl(text)`, and
`LedgerError` (with `.code`).
