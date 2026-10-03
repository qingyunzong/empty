# RESULTS

日期: 2026-10-03 23:28:35 UTC  Node: v22.22.1

## `node --test`（真实输出）

```
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
  ---
  duration_ms: 1894.299402
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2026.897828
```

## 子测试明细（`node test/acceptance.test.js`，真实输出）

```
TAP version 13
# Subtest: acceptance 1: revoke propagates downstream; attested independent branch preserved
ok 1 - acceptance 1: revoke propagates downstream; attested independent branch preserved
  ---
  duration_ms: 21.213413
  type: 'test'
  ...
# Subtest: acceptance 2: compact preserves verify; crash before rename recovers old log
ok 2 - acceptance 2: compact preserves verify; crash before rename recovers old log
  ---
  duration_ms: 43.693474
  type: 'test'
  ...
# Subtest: acceptance 3: QC failure propagates with minimal broken core
ok 3 - acceptance 3: QC failure propagates with minimal broken core
  ---
  duration_ms: 3.536682
  type: 'test'
  ...
# Subtest: constraint breaks: volume conservation and reagent compatibility
ok 4 - constraint breaks: volume conservation and reagent compatibility
  ---
  duration_ms: 6.46884
  type: 'test'
  ...
# Subtest: PENDING on exhausted audit budget is not BROKEN
ok 5 - PENDING on exhausted audit budget is not BROKEN
  ---
  duration_ms: 6.125602
  type: 'test'
  ...
# Subtest: acceptance 4: derivation closure enumeration cross-check (n <= 8)
ok 6 - acceptance 4: derivation closure enumeration cross-check (n <= 8)
  ---
  duration_ms: 193.829169
  type: 'test'
  ...
# Subtest: CLI smoke test: append, verify, compact, recover
ok 7 - CLI smoke test: append, verify, compact, recover
  ---
  duration_ms: 4.444406
  type: 'test'
  ...
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 349.728387
```
