# credit-replica

Replicated credit-limit ledger with anti-entropy repair. Node.js 22, standard
library only, tested with `node:test`.

## Model

Each replica state file holds:

- `limit` — total credit limit
- `events` — ordered log of `reserve` / `release` events
- `tombstones` — released records kept forever so stale duplicate releases
  can never resurrect

Events:

- `reserve`: `{ requestId, account, amount }`
- `release`: `{ requestId, target, amount }` where `target` references a
  reserve `requestId`; `amount` may not exceed the reserve's remaining
  releasable amount (`over-release`)

Idempotency: same `requestId` + identical payload is a no-op; same
`requestId` + different payload is rejected (`payload-conflict`). Reserving
beyond the available limit fails with `limit-exceeded`.

Anti-entropy: `diff` compares the state digest and event-ID sets and returns
the events the peer is missing; `repair` merges them (reserves before
releases). Concurrent reservations from different replicas all consume limit
after merge.

## CLI

```sh
node cli.js reserve <file> <requestId> <account> <amount> [--limit N]
node cli.js release <file> <requestId> <targetRequestId> <amount>
node cli.js diff <file> <otherFile>
node cli.js repair <file> <otherFile>
node cli.js balance <file>
```

All output is JSON. Errors print `{"error":"code"}` and exit with code 1.
A new state file is created by the first `reserve` (default limit 1000, or
`--limit N`).

## Test

```sh
node --test --test-reporter spec
```
