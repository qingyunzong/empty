# RESULTS

Date: 2026-10-02T20:53:18Z (UTC)
Node: v22.22.1
Command: `node --test` (full run, real output below)

```
✔ test/lab.test.js (3308.465098ms)
✔ test/store.test.js (3608.69813ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4575.14271
```

Per-file subtests:

```
ok 1 - link rejects cycles
ok 2 - acceptance 1: broken chain yields REFUTE with minimal core
ok 3 - acceptance 2: missing env window is INSUFFICIENT_EVIDENCE, not REFUTE
ok 4 - acceptance 3: budget boundary yields PENDING, exact boundary passes
ok 5 - CERT contains chain, combined uncertainty and hash; audit validates
ok 6 - audit detects tampering
ok 7 - reserve/release are paired; bad release returns LEASE_STATE
ok 8 - active lease on another point excludes the standard from certify
ok 9 - unlink refused while a downstream measurement is pending
ok 10 - uncertainty dominance violation is a REFUTE core constraint
ok 11 - expired standard yields REFUTE with VALIDITY core
ok 12 - env window present but not covering is REFUTE, not INSUFFICIENT
ok 13 - acceptance 4: certify matches brute-force chain enumeration for n<=8
# tests 13
# pass 13
# fail 0

ok 1 - committed measures survive reopen
ok 2 - crash after append but before rename: torn tail is invisible
ok 3 - crash with full line but no HEAD commit: record is invisible
ok 4 - leftover HEAD.tmp from crash before rename is ignored
ok 5 - corrupt committed line: recovery keeps verified prefix, no half measure
ok 6 - Lab recovers measurement points from the journal on restart
# tests 6
# pass 6
# fail 0
```
