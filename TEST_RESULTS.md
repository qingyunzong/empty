# TEST RESULTS

记录时间：2026-10-06 02:29:39 CST，Node v22.22.1，tsc Version 7.0.2

共 32 个测试全部通过（4 个测试文件）。以下为实际运行输出。

```text
$ npm test

> coupon-optimizer@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/crosscheck.test.js
ok 1 - dist/test/crosscheck.test.js
  ---
  duration_ms: 9291.805408
  type: 'test'
  ...
# Subtest: dist/test/engine.test.js
ok 2 - dist/test/engine.test.js
  ---
  duration_ms: 1022.873543
  type: 'test'
  ...
# Subtest: dist/test/single.test.js
ok 3 - dist/test/single.test.js
  ---
  duration_ms: 861.665339
  type: 'test'
  ...
# Subtest: dist/test/solver.test.js
ok 4 - dist/test/solver.test.js
  ---
  duration_ms: 1162.924342
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9437.090559

$ node dist/test/single.test.js
ok 1 - amount coupon subtracts cents and clamps at zero
ok 2 - percent coupon rounds the discount down
ok 3 - coupons apply in input order, not in a reordered sequence
ok 4 - prereq forces the prerequisite coupon into the subset
ok 5 - mutex group coupons cannot combine on one order
ok 6 - tie on payment breaks to fewer coupons
ok 7 - tie on payment and count breaks to smaller id list regardless of input order
ok 8 - enumerates all 2^n subsets
ok 9 - dangling prereq makes a coupon unusable
# tests 9
# pass 9
# fail 0

$ node dist/test/solver.test.js
ok 1 - percent coupon goes to the order where it saves most
ok 2 - shared coupon applies to several orders at once
ok 3 - non-shared coupon is owned by at most one order
ok 4 - prereq is enforced per order across orders
ok 5 - mutex group is per order: two orders may each take one coupon of the group
ok 6 - settled order keeps its locked amount
ok 7 - locked amount is reproduced exactly when a coupon must stay on the settled order
ok 8 - infeasible when a locked amount cannot be reproduced
ok 9 - tiny budget yields a feasible but unproven result
ok 10 - large budget on a small instance proves optimality
ok 11 - rejects more than 18 coupons or 8 orders
# tests 11
# pass 11
# fail 0

$ node dist/test/engine.test.js
ok 1 - single order end-to-end with prereq and mutex
ok 2 - settle locks the payment; refund revokes and reassigns the rest
ok 3 - refund can force reassignment of remaining coupons across unlocked orders
ok 4 - refund of a coupon a locked order depends on is infeasible
ok 5 - shared coupon survives across orders and refunds recompute
ok 6 - library and order limits are enforced
ok 7 - invalid coupons are rejected
ok 8 - settle requires a successful solve first
# tests 8
# pass 8
# fail 0

$ node dist/test/crosscheck.test.js
ok 1 - main solver matches independent brute force on random small instances
ok 2 - single-order enumeration matches brute force on random instances
ok 3 - solver with settled orders matches brute force on random instances
ok 4 - reported ownership always recomputes to the reported amounts
# tests 4
# pass 4
# fail 0

```
