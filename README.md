# Offline Multi-Window Clearing Engine

Node.js 22, standard library only. Clears buy/sell orders into auditable
integer fills across multiple uncommitted windows, with exact BigInt rational
arithmetic, versioned read sets, atomic commits and one-shot compensations.

## Layout

- `src/fraction.js` — normalized BigInt rationals (`den > 0`, gcd-reduced).
- `src/solver.js` — constraint propagation + branch search. Objectives:
  1. maximize total matched quantity, 2. minimize total buyer spend,
  3. lexicographically smallest fill vector (ascending order id). Reports the
  exact BigInt count of all vectors tied under objectives 1–2 and emits a
  proof tree (per-node remaining-fill upper bound `ubQ`, spend lower bound
  `lbSpend`, prune reasons `balance|funds|bound-q|bound-spend`). Search
  budget exhaustion throws `E_BUDGET` — never a fabricated zero-fill result.
- `src/checker.js` — independent verifier: re-derives every bound, checks
  each split covers its domain exactly once, validates every prune reason,
  and recomputes the optimum/tie count from the surviving leaves.
- `src/brute.js` — exhaustive enumerator (oracle for <=8 orders, qty <=3).
- `src/engine.js` — versioned state: trials record base version + read set
  (orders in priced symbols, accounts funding their buys); commit revalidates
  the read set (`E_STALE`), applies fills atomically, idempotent per commit
  id; `undo` removes only uncommitted trials; committed fills reverse only
  via a one-shot compensation (`E_ALREADY_COMPENSATED`, atomic `E_FUNDS` /
  `E_CONFLICT` failures).
- `bin/clearing.js` — JSONL CLI (one command per line, one response per
  line; BigInts serialized as strings).

## CLI protocol

```
{"cmd":"account","id":"A","funds":{"num":100,"den":1}}
{"cmd":"order","id":"o1","account":"A","symbol":"X","side":"buy","qty":2,"limit":{"num":5,"den":1}}
{"cmd":"trial","window":"w1","prices":{"X":{"num":4,"den":1}}}
{"cmd":"check","trial":"t1"}
{"cmd":"commit","id":"c1","trial":"t1"}
{"cmd":"undo","trial":"t2"}
{"cmd":"compensate","id":"r1","commit":"c1"}
{"cmd":"correct_account","id":"A","funds":50}  /  {"cmd":"correct_order","id":"o1","limit":{"num":6,"den":1}}
{"cmd":"state"}  /  {"cmd":"reset"}
```

Responses: `{"ok":true,"result":...}` or `{"ok":false,"error":{"code","message"}}`.
Error codes: `E_PRICE E_INPUT E_NOT_FOUND E_STALE E_CONFLICT E_FUNDS E_STATE
E_ALREADY_COMPENSATED E_BUDGET E_UNKNOWN_CMD`.

## Tests

```
node --test
```

Covers: fraction normalization, cross-symbol shared funds, huge fractions and
exact budget boundary, tie counting + lex-min selection, tampered count/vector
rejection by the checker, budget exhaustion, multi-window read-set conflicts
vs disjoint commits, idempotent commits, undo rules, duplicate/insufficient/
conflicting compensations, sell-proceeds availability only after commit, and
exhaustive-enumeration cross-checks (objectives, counts, determinism) for all
instances with <=8 orders and qty <=3.
