# Offline Multi-Window Clearing Engine

Clears buy/sell orders into auditable integer fills across multiple
uncommitted windows. Node.js 22, standard library only (`node:test`,
`node:readline`). All arithmetic is exact BigInt rational arithmetic with
normalized fractions (`den > 0`, gcd-reduced).

## Layout

- `src/fraction.js` — normalized BigInt rationals (`{num, den}`).
- `src/solver.js` — constraint propagation + branch search; emits a proof
  tree with per-node propagated bounds, remaining-volume upper bounds and
  spend lower bounds, plus prune reasons (`flow_infeasible`,
  `funds_infeasible`, `volume_bound`, `spend_bound`).
- `src/checker.js` — independent checker: replays the proof tree, verifies
  every split covers its variable domain exactly, validates every prune
  reason, and recounts the optimal tie count.
- `src/engine.js` — multi-window engine: trials with read sets, versioned
  commits, undo, idempotent submissions, one-shot compensations.
- `src/cli.js` — JSONL CLI (one JSON command per line on stdin, one JSON
  response per line on stdout; BigInts serialized as decimal strings).

## Semantics

- An order participates iff buy limit >= clearing price (sell: <=).
- Per instrument, total buy fills equal total sell fills; each fill is an
  integer in `[0, remaining]`. Buyer accounts must cover their spend;
  sell proceeds only become spendable after a commit.
- Objectives, lexicographic: (1) maximize total cleared volume,
  (2) minimize total buyer spend, (3) pick the lexicographically smallest
  fill vector ordered by ascending order id. The exact number of vectors
  tied on (1)+(2) is reported as a BigInt.
- A trial records its read set (base version + versions of every account,
  order and instrument it read, optionally scoped to a set of
  instruments). `commit` revalidates the read set: trials that read
  modified objects fail with `E_STALE` and are never silently recomputed;
  trials with disjoint read sets stay committable.
- `commit`/`compensate` are idempotent per submission id. `undo` only
  removes uncommitted trials. A committed fill is reversed exactly once by
  `compensate`, which fails atomically (`E_FUNDS` / `E_CONFLICT`) if a
  seller cannot return proceeds or an order changed since the commit.
- Search budget exhaustion returns `E_BUDGET`; it is never reported as a
  zero-fill result.

## CLI

```sh
node src/cli.js <<'CMDS'
{"op":"account","id":"A","funds":{"num":"10","den":"1"}}
{"op":"account","id":"B","funds":"0"}
{"op":"instrument","id":"X","price":{"num":"3","den":"2"}}
{"op":"order","id":"O1","account":"A","side":"buy","instrument":"X","qty":"3","limit":{"num":"2","den":"1"}}
{"op":"order","id":"O2","account":"B","side":"sell","instrument":"X","qty":"3","limit":{"num":"1","den":"1"}}
{"op":"trial","window":"W1","proof":false}
{"op":"commit","window":"W1","submit":"S1"}
CMDS
```

Ops: `account`, `instrument`, `order`, `trial` (optional `instruments`,
`budget`, `proof`), `verify`, `commit`, `undo`, `compensate`, `state`.

## Tests

```sh
node --test
```

Coverage includes: cross-instrument shared account funds, huge fractions,
exact budget boundaries, multi-window read-set conflicts and disjoint
commits, repeated compensation, tampered tie counts rejected by the
independent checker, and a brute-force cross-check: for every random
instance with <= 8 orders and quantities <= 3 an independent enumerator
validates the objective values, the tie count, the lex-min vector and
determinism.

Recorded run (2026-10-07, Node v22.22.1):

```
# tests 5        (test files: cli, engine, fraction, helpers, solver)
# pass 5
# fail 0
# 27 subtests total, all passing (4 fraction, 10 solver, 11 engine, 2 cli)
```
