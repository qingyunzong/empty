# Leaderboard

TypeScript leaderboard library (Node.js built-ins only, zero runtime
dependencies) maintaining integer user scores driven by an append-only
event ledger with single-shot revocation.

## Rules

- **Events**: `{ id, username, delta }`, `delta` is any integer (negative
  allowed; user totals may go negative).
- **Idempotent apply**: re-applying the same `id` with identical content
  is a no-op; the same `id` with different content is rejected with
  `DuplicateEventError`.
- **Revocation**: `revoke(id)` removes the event's delta exactly once.
  A second revoke throws `AlreadyRevokedError`; an unknown id throws
  `UnknownEventError`. A revoked id stays revoked even if the same event
  is replayed.
- **Ranking**: higher score first; ties broken by username in UTF-8 byte
  order (`Buffer.compare` on UTF-8 encodings). Ranks are 1-based.
- **TopK net changes**: every mutation returns `{ entered, left, changed }`
  describing how the TopK window moved.
- **Verification**: `verify()` recomputes all scores and the full ranking
  from the ledger and cross-checks the incremental state, throwing
  `LedgerMismatchError` on divergence.

## Usage

```ts
import { Leaderboard } from "./src/leaderboard";

const lb = new Leaderboard(3); // track Top 3

lb.apply({ id: "e1", username: "alice", delta: 5 });
// => { entered: [{ rank: 1, username: "alice", score: 5 }], left: [], changed: [] }

lb.apply({ id: "e2", username: "bob", delta: -2 });   // negative scores OK
lb.apply({ id: "e1", username: "alice", delta: 5 });  // idempotent no-op
lb.apply({ id: "e1", username: "alice", delta: 6 });  // throws DuplicateEventError

lb.revoke("e2");   // OK
lb.revoke("e2");   // throws AlreadyRevokedError

lb.topK();         // [{ rank: 1, username: "alice", score: 5 }]
lb.verify();       // full-ledger recompute; throws on mismatch
```

## Test

```
npm test
```

Compiles with `tsc` (TypeScript 7) and runs the `node:test` suite
(21 tests across 6 suites: accumulation/negatives, event identity,
revocation, UTF-8 ranking, TopK diffs, full-ledger verification
including a 500-step deterministic fuzz run verified after every
mutation).

## Actual test result

Recorded from `npm test` on 2026-10-07 (Node v22.22.1, typescript 7.0.2):

```
# Subtest: score accumulation .................. ok (3 tests)
# Subtest: event identity ...................... ok (3 tests)
# Subtest: revocation .......................... ok (4 tests)
# Subtest: ranking order ....................... ok (3 tests)
# Subtest: TopK net changes .................... ok (5 tests)
# Subtest: full-ledger verification ............ ok (3 tests)
1..6
# tests 21
# suites 6
# pass 21
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 165.500274
```
