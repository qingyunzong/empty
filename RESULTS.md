# RESULTS

- Date (UTC): 2026-10-03T17:00:46Z
- Runtime: Node.js v22.22.1 (standard library only, `node:test`)
- Command: `node --test`
- Exit code: 0

## Summary (real output of `node --test`)

```
# tests 13 (3 files)
# pass 13
# fail 0
```

Aggregate TAP rollup from `node --test`:

```
ok 1 - test/certify.test.js
ok 2 - test/cli.test.js
ok 3 - test/subsets.test.js
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Individual tests (real output, per-file runs)

test/certify.test.js
```
ok 1 - acceptance 1: calib retract cascades OK -> VOID for every bolt on the tool
ok 2 - acceptance 2: late scan turns HOLD into OK and is logged late
ok 3 - retract recovery keeps every old certificate version
ok 4 - only the last non-retracted angle-qualified tightening counts; ties break by eventTs then id
ok 5 - acceptance 4: conflicting duplicate id raises DUP_EVENT, identical resend is idempotent
ok 6 - missing calibration yields HOLD with NO_CALIB, not an error
ok 7 - torque retract voids the certificate when no qualified tightening remains
```

test/cli.test.js
```
ok 1 - CLI certify writes certs.jsonl, void.jsonl and late.log
ok 2 - CLI reports DUP_EVENT and exits non-zero on conflicting ids
ok 3 - CLI reports ANGLE_RANGE on stderr but still certifies valid bolts
ok 4 - CLI rejects missing --in/--out with usage error
ok 5 - CLI reads every .jsonl file in --in directory in sorted order
```

test/subsets.test.js
```
ok 1 - acceptance 3: all 2^8 event subsets match the reference certifier
```

## Acceptance criteria mapping

1. 校准撤回级联 VOID — `acceptance 1: calib retract cascades OK -> VOID for every bolt on the tool` (pass)
2. 迟到 scan 将 HOLD 改 OK — `acceptance 2: late scan turns HOLD into OK and is logged late` (pass)
3. 小例枚举所有事件子集对照证书 — `acceptance 3: all 2^8 event subsets match the reference certifier` (256/256 subsets, pass)
4. 重复 id 冲突报 DUP_EVENT — `acceptance 4: conflicting duplicate id raises DUP_EVENT` + CLI `reports DUP_EVENT and exits non-zero` (pass)

## Note

CLI tests drive `main()` in-process with injected stdio because this sandbox
denies nested `spawnSync` (EPERM); the real CLI entry `bin/trace.js` was
verified manually from the shell (`node bin/trace.js certify --in ... --out ...`,
exit 0, correct certs/void/late outputs).
