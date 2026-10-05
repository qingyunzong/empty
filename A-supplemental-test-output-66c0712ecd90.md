A 补充验证输出

对应产物：https://github.com/qingyunzong/empty/commit/dddb99440feee26bb3019094ee128440fd0c6ac2

本次为交付后的补充验证，不属于 A 原会话；原会话显示 6 个测试文件通过。

环境：Linux，Node.js v22.22.1。从上述固定提交创建独立副本，无源码修改、无外部依赖。

命令：node --test

退出码：0

完整标准输出及标准错误：

```text
TAP version 13
# Subtest: exit 0 and CONCURRENT_OK on the three-device example
ok 1 - exit 0 and CONCURRENT_OK on the three-device example
  ---
  duration_ms: 29.335655
  type: 'test'
  ...
# Subtest: exit 6 and CONFLICT with a minimal cycle on the cycle example
ok 2 - exit 6 and CONFLICT with a minimal cycle on the cycle example
  ---
  duration_ms: 3.837924
  type: 'test'
  ...
# Subtest: exit 2 on INVALID_HISTORY
ok 3 - exit 2 on INVALID_HISTORY
  ---
  duration_ms: 2.790165
  type: 'test'
  ...
# Subtest: exit 4 on PENDING and never judges conflict
ok 4 - exit 4 on PENDING and never judges conflict
  ---
  duration_ms: 12.073372
  type: 'test'
  ...
# Subtest: acceptance 4: n<=8 merge verdicts agree with exhaustive topological enumeration
ok 5 - acceptance 4: n<=8 merge verdicts agree with exhaustive topological enumeration
  ---
  duration_ms: 164.091295
  type: 'test'
  ...
# Subtest: kahn sorts a chain and reports a unique order
ok 6 - kahn sorts a chain and reports a unique order
  ---
  duration_ms: 8.743714
  type: 'test'
  ...
# Subtest: kahn reports branching (non-unique order) on a diamond
ok 7 - kahn reports branching (non-unique order) on a diamond
  ---
  duration_ms: 1.055585
  type: 'test'
  ...
# Subtest: kahn exposes the cyclic remainder
ok 8 - kahn exposes the cyclic remainder
  ---
  duration_ms: 2.666977
  type: 'test'
  ...
# Subtest: kahn returns pending when the budget runs out
ok 9 - kahn returns pending when the budget runs out
  ---
  duration_ms: 1.763488
  type: 'test'
  ...
# Subtest: minimalCycle finds the shortest cycle
ok 10 - minimalCycle finds the shortest cycle
  ---
  duration_ms: 4.220151
  type: 'test'
  ...
# Subtest: minimalCycle respects the budget
ok 11 - minimalCycle respects the budget
  ---
  duration_ms: 1.558745
  type: 'test'
  ...
# Subtest: ancestorsOf computes strict ancestry
ok 12 - ancestorsOf computes strict ancestry
  ---
  duration_ms: 2.534046
  type: 'test'
  ...
# Subtest: test/helpers.js
ok 4 - test/helpers.js
  ---
  duration_ms: 262.957215
  type: 'test'
  ...
# Subtest: acceptance 1: three-device merge matches a legal serialization
ok 14 - acceptance 1: three-device merge matches a legal serialization
  ---
  duration_ms: 15.503742
  type: 'test'
  ...
# Subtest: single-device history is LINEARIZABLE_MODEL
ok 15 - single-device history is LINEARIZABLE_MODEL
  ---
  duration_ms: 1.810011
  type: 'test'
  ...
# Subtest: concurrent writes to one cell with different tiers conflict
ok 16 - concurrent writes to one cell with different tiers conflict
  ---
  duration_ms: 1.844942
  type: 'test'
  ...
# Subtest: concurrent writes to one cell with equal tiers merge cleanly
ok 17 - concurrent writes to one cell with equal tiers merge cleanly
  ---
  duration_ms: 1.011181
  type: 'test'
  ...
# Subtest: acceptance 2: causal cycle returns a minimal cycle
ok 18 - acceptance 2: causal cycle returns a minimal cycle
  ---
  duration_ms: 3.343878
  type: 'test'
  ...
# Subtest: acceptance 3: PENDING when the cycle-detection budget is exhausted, no conflict judged
ok 19 - acceptance 3: PENDING when the cycle-detection budget is exhausted, no conflict judged
  ---
  duration_ms: 22.076911
  type: 'test'
  ...
# Subtest: morph_species propagates globally to unsynced facts on all devices
ok 20 - morph_species propagates globally to unsynced facts on all devices
  ---
  duration_ms: 3.357538
  type: 'test'
  ...
# Subtest: morph_species must not rewrite facts already committed by a sync
ok 21 - morph_species must not rewrite facts already committed by a sync
  ---
  duration_ms: 3.392575
  type: 'test'
  ...
# Subtest: morph merging two recorded populations violates total-count conservation
ok 22 - morph merging two recorded populations violates total-count conservation
  ---
  duration_ms: 4.125596
  type: 'test'
  ...
# Subtest: move_plot relocates records and respects capacity of the target plot
ok 23 - move_plot relocates records and respects capacity of the target plot
  ---
  duration_ms: 1.655535
  type: 'test'
  ...
# Subtest: undo_op retracts an unsynced op
ok 24 - undo_op retracts an unsynced op
  ---
  duration_ms: 1.018251
  type: 'test'
  ...
# Subtest: undo_op of a synced op is INVALID_HISTORY
ok 25 - undo_op of a synced op is INVALID_HISTORY
  ---
  duration_ms: 1.21229
  type: 'test'
  ...
# Subtest: undo_op across devices is INVALID_HISTORY
ok 26 - undo_op across devices is INVALID_HISTORY
  ---
  duration_ms: 0.401816
  type: 'test'
  ...
# Subtest: parses a valid history
ok 27 - parses a valid history
  ---
  duration_ms: 12.761086
  type: 'test'
  ...
# Subtest: rejects invalid JSON lines
ok 28 - rejects invalid JSON lines
  ---
  duration_ms: 3.091828
  type: 'test'
  ...
# Subtest: rejects unknown op types
ok 29 - rejects unknown op types
  ---
  duration_ms: 1.528149
  type: 'test'
  ...
# Subtest: rejects non-monotonic per-device time
ok 30 - rejects non-monotonic per-device time
  ---
  duration_ms: 1.551986
  type: 'test'
  ...
# Subtest: rejects mixed devices in one file
ok 31 - rejects mixed devices in one file
  ---
  duration_ms: 2.217232
  type: 'test'
  ...
# Subtest: rejects duplicate op ids
ok 32 - rejects duplicate op ids
  ---
  duration_ms: 1.856759
  type: 'test'
  ...
# Subtest: rejects unknown species / plots / tiers against config
ok 33 - rejects unknown species / plots / tiers against config
  ---
  duration_ms: 3.009102
  type: 'test'
  ...
# Subtest: rejects morphologically incompatible set_count
ok 34 - rejects morphologically incompatible set_count
  ---
  duration_ms: 2.129118
  type: 'test'
  ...
# Subtest: rejects dangling sync sessions at graph build
ok 35 - rejects dangling sync sessions at graph build
  ---
  duration_ms: 9.510971
  type: 'test'
  ...
1..35
# tests 35
# suites 0
# pass 35
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 625.784882
```
