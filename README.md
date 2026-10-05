# MVCC Snapshot Isolation (TypeScript, zero runtime deps)

An in-memory relational store implementing **snapshot isolation (SI)** on top of
multi-version concurrency control. TypeScript + Node.js built-ins only
(`node:test`, `node:assert`); compiled with `tsc`, no runtime dependencies.

## Semantics implemented

- **Consistent multi-table snapshot**: `begin()` pins `snapshotTs = lastCommitTs`;
  every read/scan in the transaction — across any number of tables — sees exactly
  the versions with `commitTs <= snapshotTs` (`src/mvcc.ts`).
- **Read-your-own-writes**: writes are staged in a private write-set that overlays
  the snapshot for the owning transaction only; other transactions never see
  staged data (`Transaction.read`, `Transaction.scan`).
- **Commit validates ONLY the write-set**: for each written key, commit aborts if
  a version with `commitTs > snapshotTs` exists (first-committer-wins). The
  read-set is never validated, so **write skew is possible by design** and is
  pinned by an explicit test (`test/write-skew.test.ts`).
- **Commit conflict evidence**: aborts throw `CommitConflictError` carrying
  `{table, key, snapshotTs, conflictingCommitTs}` for every conflicting key
  (`test/commit-conflict.test.ts`).
- **Barrier history vs full version model**: the engine records its complete
  observable history (`db.history`) including `barrier` events that split it into
  epochs. `reconcileBarrierHistory()` (`src/model.ts`) replays the history against
  an independent full version model and checks: reads match the model at the
  transaction's snapshot (overlaid with own staged writes), commits have no newer
  version on any write-set key, conflict-abort evidence points at real newer
  versions, commitTs is strictly increasing and monotone across barrier epochs,
  and finally the model's complete version chains equal the engine's actual
  version chains (`db.versionChains()`).

## Layout

- `src/mvcc.ts` — engine: `Database`, `Transaction`, `CommitConflictError`, history recording
- `src/model.ts` — `FullVersionModel` + `reconcileBarrierHistory()` checker
- `test/read-your-writes.test.ts` — staged writes visible to self only
- `test/commit-conflict.test.ts` — write-write conflict evidence; write-set-only validation
- `test/write-skew.test.ts` — write skew CAN occur (explicitly asserted)
- `test/multi-table-snapshot.test.ts` — consistent snapshot across tables
- `test/barrier-history.test.ts` — seeded randomized + scripted barrier histories
  reconciled against the full version model, plus a tamper-detection sanity check
- `types/node-shims.d.ts` — minimal ambient types for `node:test`/`node:assert`
  (drop-in until `@types/node` can be installed)

## Commands

```sh
npm test        # tsc build + node --test dist/test/*.test.js
npm run build   # compile TypeScript to dist/
```

## Actual test results

Environment: Node.js v22.22.1, npm 9.2.0, TypeScript 7.0.2 (global `tsc`).

```
$ npm test
# Subtest: dist/test/barrier-history.test.js
ok 1 - dist/test/barrier-history.test.js
# Subtest: dist/test/commit-conflict.test.js
ok 2 - dist/test/commit-conflict.test.js
# Subtest: dist/test/multi-table-snapshot.test.js
ok 3 - dist/test/multi-table-snapshot.test.js
# Subtest: dist/test/read-your-writes.test.js
ok 4 - dist/test/read-your-writes.test.js
# Subtest: dist/test/write-skew.test.js
ok 5 - dist/test/write-skew.test.js
1..5
# tests 5
# pass 5
# fail 0
```

5/5 test files pass (12 individual `node:test` cases), including the randomized
barrier-history reconciliation across 5 seeds × 40 epochs with zero violations.
