# fx-settlement

Multi-currency settlement pairing by value-date queues. Node.js 22, standard
library only (`node:test` for tests), single-machine, offline.

Dependency graph: **trades → currency-pair nets → value-date queues →
settlement instructions**. Queues are maintained differentially (dirty-bucket
invalidation); a holiday-calendar version change is a topology change that
re-rolls value dates (UTC "following" convention) and propagates invalidation
to subsequent value dates. Cancelling a paired trade unlocks both sides and
records a compensation entry. Insufficient liquidity is never a failure:
trades stay `PENDING` with a retained reason.

## Test

```sh
node --test
```

## CLI

```sh
# apply JSONL events from stdin, persist, print reports
node cli.js apply --state ./.fxstate < events.jsonl

# rebuild from the event log, verify/rebuild the queue index, print reports
node cli.js replay --state ./.fxstate
```

Output (stdout, JSONL): one line each of `deliverable` (settlement
instructions / PENDING + reason), `exposure` (pair nets + pending per
currency), `proof` (event count, hash-chain head, state hash — replayable and
deterministic). Errors go to stderr with exit code 7.

## Events (JSONL)

```json
{"type":"trade","id":"T1","pair":"EUR/USD","amount":100,"rate":1.2,"valueDate":"2026-10-05","maturity":"2026-10-05T09:00:00Z"}
{"type":"liquidity","ccy":"USD","date":"2026-10-05","amount":250}
{"type":"cancel","id":"T1","amount":40}
{"type":"delay","id":"T1","valueDate":"2026-10-07"}
{"type":"reprice","id":"T1","rate":1.3}
{"type":"calendar","version":1,"holidays":["2026-10-05"]}
```

Tie-break within a value-date queue: maturity timestamp, then trade id.
Persistence: `events.jsonl` is the source of truth; `index.json` is a derived
queue-index cache — a torn/stale index is detected and rebuilt from the log on
restart.
