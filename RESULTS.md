# Test Results

Command: `node --test` (Node.js v22.22.1, 2026-10-03T04:42:33Z)

Exit code: 0

```
TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
  ---
  duration_ms: 69927.118957
  type: 'test'
  ...
# Subtest: test/crash.test.js
ok 2 - test/crash.test.js
  ---
  duration_ms: 11063.960757
  type: 'test'
  ...
# Subtest: test/helpers.js
ok 3 - test/helpers.js
  ---
  duration_ms: 3742.350851
  type: 'test'
  ...
# Subtest: test/merge.test.js
ok 4 - test/merge.test.js
  ---
  duration_ms: 11983.116613
  type: 'test'
  ...
# Subtest: test/tombstone.test.js
ok 5 - test/tombstone.test.js
  ---
  duration_ms: 1969.132551
  type: 'test'
  ...
# Subtest: test/vclock.test.js
ok 6 - test/vclock.test.js
  ---
  duration_ms: 2640.632124
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 70210.211739
```

## Per-test breakdown (spec reporter, real output)

### node --test-reporter=spec test/cli.test.js
```
✔ CLI happy path: init / put / correct / delete / status (11334.049869ms)
✔ CLI put accepts a batch of JSON lines atomically (7123.458275ms)
✔ CLI merge between stores and via stdin, idempotent on repeat (20489.232647ms)
✔ CLI compare reports concurrency of two histories (5987.410218ms)
✔ CLI errors: single-line {code,msg} on stderr, non-zero exit (34951.789767ms)
✔ CLI compact: refuses before all nodes have seen the tombstone (13495.140563ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 93568.710875
```

### node --test-reporter=spec test/crash.test.js
```
✔ acceptance 4: kill before log write leaves no trace of the batch (968.678771ms)
✔ acceptance 4: kill mid-write (torn batch, no commit) is fully discarded (866.520775ms)
✔ acceptance 4: kill after write but before fsync exposes the whole batch or nothing (975.415441ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2883.55256
```

### node --test-reporter=spec test/merge.test.js
```
✔ acceptance 1: three-way concurrent correction merge matches all-permutation reference (1955.193393ms)
✔ merge is associative at store level (7.03815ms)
✔ acceptance 3: duplicate and out-of-order delivery is idempotent (8.154872ms)
✔ mergeEvents rejects malformed events with INVALID_INPUT (3.022913ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2036.084652
```

### node --test-reporter=spec test/tombstone.test.js
```
✔ acceptance 2: deleted old value cannot resurrect via late or duplicate delivery (79.582471ms)
✔ acceptance 2: compaction preserves visible state and blocks resurrection (18.812355ms)
✔ compaction is refused until every node has seen the tombstone (14.703378ms)
✔ compaction respects the parameterized retention period (19.626475ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 188.168149
```

### node --test-reporter=spec test/vclock.test.js
```
✔ compareVclock: equal, before, after (11.620234ms)
✔ compareVclock: concurrent histories are detected (1.740303ms)
✔ dominates: causal coverage (0.940956ms)
✔ mergeVclock: commutative, associative, idempotent (7.400328ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 67.763897
```

