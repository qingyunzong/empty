# 实际测试结果记录

日期: 2026-10-05 21:57:59 CST
环境: v22.22.1, npm 9.2.0, tsc Version 7.0.2

## `npm test` 输出（原文）

```

> perm-diff@1.0.0 test
> npm run build && node --test "dist/test/*.test.js"


> perm-diff@1.0.0 build
> tsc -p tsconfig.json

TAP version 13
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
  ---
  duration_ms: 464.240806
  type: 'test'
  ...
# Subtest: dist/test/evaluate.test.js
ok 2 - dist/test/evaluate.test.js
  ---
  duration_ms: 428.638527
  type: 'test'
  ...
# Subtest: dist/test/order.test.js
ok 3 - dist/test/order.test.js
  ---
  duration_ms: 449.651177
  type: 'test'
  ...
# Subtest: dist/test/search.test.js
ok 4 - dist/test/search.test.js
  ---
  duration_ms: 443.915838
  type: 'test'
  ...
# Subtest: dist/test/spec.test.js
ok 5 - dist/test/spec.test.js
  ---
  duration_ms: 453.524352
  type: 'test'
  ...
# Subtest: dist/test/verify.test.js
ok 6 - dist/test/verify.test.js
  ---
  duration_ms: 458.627307
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
# duration_ms 515.849983
npm test exit=0
```

## 各测试文件明细（逐文件 `node <file>` 运行，TAP 汇总行）

```
cli.test.js                  # pass 10 # fail 0 
evaluate.test.js             # pass 6 # fail 0 
order.test.js                # pass 3 # fail 0 
search.test.js               # pass 9 # fail 0 
spec.test.js                 # pass 12 # fail 0 
verify.test.js               # pass 9 # fail 0 
```

合计 49 个断言级测试，全部通过（6 个测试文件）。

## 示例实际运行

### examples/differ.json

```
verdict: DIFFER
witness: { role: "admin", mfa: false }  (2 specified fields)
  baseline: permit
  hardened: deny
checked: 6 of 9 partial assignments (budget 1000000)
cross-check: passed
  ok - witness is well-formed (declared attributes, in-domain values)
  ok - both policies are determined and disagree on every total extension of the witness
  ok - minimality: all 5 earlier candidates in canonical order are non-witnesses
(exit=0)
```

### examples/equivalent.json

```
verdict: EQUIVALENT (exhaustive: no attribute assignment makes the policies differ)
checked: 9 of 9 partial assignments (budget 1000000)
cross-check: passed
  ok - primary search covered the whole partial space (9 candidates)
  ok - all 4 total assignments give identical decisions
(exit=1)
```

### examples/undecided.json

```
verdict: UNDECIDED (budget exhausted before the search space was fully enumerated)
checked: 10 of 256 partial assignments (budget 10)
cross-check: passed
  ok - re-enumerated the 10 checked candidates: none is a witness, and the space continues beyond the budget
(exit=2)
```

