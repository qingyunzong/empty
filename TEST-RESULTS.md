# 真实测试结果

环境：Node.js v22.22.1，Linux，单机离线。命令：`node --test`（全量）。
记录时间：2026-10-03T19:25Z（UTC）。

## `node --test --test-reporter=spec` 实际输出（摘要）

```
✔ test/cli.test.js (2416.88783ms)
✔ test/enumerate.test.js (1643.975501ms)
✔ test/helpers.js (576.4307ms)
✔ test/plan.test.js (1413.213373ms)
✔ test/store.test.js (1190.294745ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2712.012537
```

## 用例覆盖（全部通过）

- test/plan.test.js：7 例 —— 净额保护（fixAmounts/drop 不平衡拒绝）、平衡修正接受、
  REVERSAL 因果（先于原交易拒绝、drop 原交易保留冲正拒绝、成对 drop 接受）、
  moveBefore 排序与非法 id、顺序移动组合。
- test/store.test.js：12 例 —— 正常 rewrite+commit；跨日重写 exit 21；commit 后
  不可动 exit 21；三个故障点注入后 recover 分别为 OPEN_OLD / OPEN_NEW /
  COMMITTED_NEW 且数据完整可再提交；两种歧义场景 exit 23；REVERSAL 因果 exit 22；
  净额保护 exit 22；add 时冲正引用校验；空库 OLD_COMMITTED。
- test/cli.test.js：5 例 —— 完整流程；exit 21/22/23；三故障点经 CLI 注入后
  recover 结果确定（OPEN_OLD / OPEN_NEW→OPEN_OLD / COMMITTED_NEW）。
- test/enumerate.test.js：n=1..6，全量枚举 drop 子集（2^n）× 全部单点 move
  （n·(n-1)+1），与独立参考实现对照净额与因果：accepted=90，rejected=2844，
  接受时逐条比对最终顺序与金额。

注：沙箱禁止 spawn 子进程，CLI 测试通过进程内调用 `lib/cli.js#run` 断言退出码
（`bin/day.js` 仅为薄封装，`process.exitCode = cli.run(...)`），退出码语义一致。
