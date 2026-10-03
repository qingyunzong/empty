# RESULTS

Environment: Node.js v22.22.1, standard library only, `node:test` runner.
Command: `node --test` (exit code 0).

## Acceptance criteria → tests

1. **撤销前后历史可验证且新用途被拒** — `test/revocation.test.js`
   Chain verifies before and after the `revoke` tombstone; old events are
   retained and flagged `restricted: true`; new events on the revoked consent
   are rejected with `REVOKED_CONSENT`; unrelated consents remain usable.
2. **改任一事件 verify 失败定位** — `test/tamper.test.js`
   Each of the 4 events is tampered in turn (payload and stored-hash cases);
   `verifyEvents` throws `BROKEN_CHAIN` with `details.index` equal to the
   tampered index every time.
3. **故障注入恢复无半快照** — `test/crash.test.js`
   Orphan tmp manifest → cleaned, head unchanged; dangling manifest (events
   lost) → discarded, old head kept; torn trailing event → truncated to last
   valid head; committed snapshot → head matches manifest after recovery;
   post-snapshot appends keep chain and manifest consistent.
4. **证明与暴力重算参考一致** — `test/merkle.test.js`
   Independent brute-force reference (rebuilt in the test from `node:crypto`)
   agrees on roots for sizes 1..64 and on every leaf's proof path for
   n ∈ {1,2,3,5,8,13,16,31,33,64}; 25 random challenges verify offline;
   out-of-range challenge → `NO_PROOF`; tampered proofs fail.

## Test run output (real)

```
$ node --test
# Subtest: test/crash.test.js     ok   (5 subtests)
# Subtest: test/merkle.test.js    ok   (5 subtests)
# Subtest: test/revocation.test.js ok  (1 subtest)
# Subtest: test/tamper.test.js    ok   (6 subtests)
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2353.150499
```

Per-file subtest counts (each file run standalone, all passing):

| file | tests | pass | fail |
|---|---|---|---|
| test/crash.test.js | 5 | 5 | 0 |
| test/merkle.test.js | 5 | 5 | 0 |
| test/revocation.test.js | 1 | 1 | 0 |
| test/tamper.test.js | 6 | 6 | 0 |
| **total** | **17** | **17** | **0** |

## CLI smoke test (real, /tmp/custody-demo2)

- `event receive` / `event transfer` appended with chained hashes (seq 0, 1).
- `revoke --consent C1` appended tombstone at seq 2.
- `event analyze --consent C1` afterwards →
  `{"error":"REVOKED_CONSENT","message":"consent 'C1' has been revoked; refusing new analyze event"}`, exit 1.
- `challenge --index 1` → proof with root `072dcaa9…7d099`; `verify --proof proof.json` → `{"proofValid": true}` (offline).
- `verify` → `{"chainValid": true, "eventCount": 3}` with matching merkle root.
- `snapshot` → manifest `{seq: 2, headHash: 9c92929f…, merkleRoot: 072dcaa9…}`.
- `challenge --index 99` → `{"error":"NO_PROOF"}`, exit 1.
- `list` → all 3 events flagged `"restricted": true`, history intact.
