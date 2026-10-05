# 测试结果记录

- 日期：2026-10-05 10:33:18 CST
- 环境：Node.js v22.22.1，tsc Version 7.0.2，npm 9.2.0
- 命令：`npm test`（tsc 编译后运行 node --test）
- 退出码：0（全部通过）

## `npm test` 输出

```

> ranking-events@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/ranking.test.js
ok 1 - dist/test/ranking.test.js
  ---
  duration_ms: 1929.289556
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
# duration_ms 1985.864893
```

## 各用例明细（node dist/test/ranking.test.js）

```
TAP version 13
# Subtest: 基本积分：胜3 平1 负0，按积分排名
ok 1 - 基本积分：胜3 平1 负0，按积分排名
  ---
  duration_ms: 18.778902
  type: 'test'
  ...
# Subtest: 同分：相互战绩优先于总净胜分
ok 2 - 同分：相互战绩优先于总净胜分
  ---
  duration_ms: 1.61944
  type: 'test'
  ...
# Subtest: 同分：小联赛净胜分（两回合相互战绩积分相同）
ok 3 - 同分：小联赛净胜分（两回合相互战绩积分相同）
  ---
  duration_ms: 1.955599
  type: 'test'
  ...
# Subtest: 同分：连环平局递归无进展时按 ID
ok 4 - 同分：连环平局递归无进展时按 ID
  ---
  duration_ms: 2.198347
  type: 'test'
  ...
# Subtest: 同分：递归平局——子组按同一规则再分（相互比赛决定）
ok 5 - 同分：递归平局——子组按同一规则再分（相互比赛决定）
  ---
  duration_ms: 1.984478
  type: 'test'
  ...
# Subtest: 取消场次：回滚积分并重算受影响名次
ok 6 - 取消场次：回滚积分并重算受影响名次
  ---
  duration_ms: 3.442763
  type: 'test'
  ...
# Subtest: 取消未比赛的场次不影响名次
ok 7 - 取消未比赛的场次不影响名次
  ---
  duration_ms: 3.959557
  type: 'test'
  ...
# Subtest: 更正结果：胜负反转后重算名次
ok 8 - 更正结果：胜负反转后重算名次
  ---
  duration_ms: 7.717989
  type: 'test'
  ...
# Subtest: 更正结果：只改比分不改胜负时仍重算同分组
ok 9 - 更正结果：只改比分不改胜负时仍重算同分组
  ---
  duration_ms: 4.516802
  type: 'test'
  ...
# Subtest: 脚本化事件序列：每步与完整重算核对
ok 10 - 脚本化事件序列：每步与完整重算核对
  ---
  duration_ms: 10.248664
  type: 'test'
  ...
# Subtest: 非法操作抛出异常
ok 11 - 非法操作抛出异常
  ---
  duration_ms: 9.078441
  type: 'test'
  ...
# Subtest: 模糊测试：随机事件序列下增量名次与完整重算一致
ok 12 - 模糊测试：随机事件序列下增量名次与完整重算一致
  ---
  duration_ms: 1112.782967
  type: 'test'
  ...
1..12
# tests 12
# suites 0
# pass 12
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1335.995497
```
