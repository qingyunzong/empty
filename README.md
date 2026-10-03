# Trade Order Saga

Node.js 22, standard library only. Event-sourced trade order placement with two
parallel branches (risk-control approval and account freeze) that must join
before a trade is confirmed.

## Layout

- `src/engine.js` — `TradingEngine` library (JSONL event log + replay + idempotency + crash recovery)
- `cli.js` — CLI wrapper emitting a JSON certificate with a state hash
- `test/trading.test.js` — `node:test` suite with an independent enumerator
  (4 branch-result combos x 2 fault points) plus acceptance scenarios
- `result.txt` — real exit code and full output of `node --test`

## Model

Events are appended to `<workdir>/events.jsonl` **before** any state mutation.
State is rebuilt by replaying the log, so the same `tradeId` + event `id` is
always idempotent and branch events may arrive out of order or duplicated.

- `instruction` — `{id, type, tradeId, amount, riskResult, accountResult, crashBeforeConfirm?, manualBranches?}`.
  Registers the trade and (unless `manualBranches`) persists the `risk` and
  `account` branch events, then joins.
- `risk` / `account` — branch arrivals. A passing account branch freezes
  `amount` (real balance check enforced).
- `confirm` — the join. Fails with `CONFIRM_NOT_READY` unless both branches
  arrived. Both pass -> `filled`; any rejection -> `cancelled` and the freeze
  is released.
- `crashBeforeConfirm: true` — both branch events are persisted, then the
  engine stops before confirming (simulated crash). Re-open the engine and
  call `recover()` to confirm exactly once; recovery is idempotent across
  restarts.

## CLI

```
node cli.js <workdir> <event-json | "-" for stdin>
```

Success: JSON certificate on stdout (`status`, `tradeStatus`, `balances`,
`eventCount`, `stateHash` = sha256 of the canonical state). Errors: exit code
1 with `{"error":"CODE","message":"..."}` on stdout.

## Test

```
node --test
```
