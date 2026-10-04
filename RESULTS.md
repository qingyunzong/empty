# RESULTS

日期：2026-10-04 11:58:48 CST
运行时：v22.22.1（仅标准库，离线）

## `node --test`（TAP 汇总）

```
TAP version 13
# Subtest: test/eventbus.test.js
ok 1 - test/eventbus.test.js
  ---
  duration_ms: 6929.596277
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
# duration_ms 7294.663214
```

## 逐测试明细（`node test/eventbus.test.js`）

```
ok 1 - concurrent branches vs real causal order
ok 2 - cycle produces SCC and consistent reachability
ok 3 - random partial orders match brute-force transitive closure
ok 4 - layered checkpoints and precise rollback
ok 5 - invalid inputs are rejected
ok 6 - scc filters singletons and sorts members
ok 7 - cli processes jsonl replay
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1226.958962
```

## 验收对照

1. 三条分支并发与真实先后可区分 —— `concurrent branches vs real causal order`：同刻三分支 CONCURRENT，link 确立 REACHABLE/NOT_REACHABLE，ts 递增无路径为 UNDECIDED（未误报 NOT_REACHABLE）。
2. A→B→C→A 的 SCC 与可达性一致 —— `cycle produces SCC and consistent reachability`：scc 输出 [[A,B,C]]，环内双向 REACHABLE，环到 D 单向可达。
3. n<=9 随机偏序对照暴力传递闭包 —— `random partial orders match brute-force transitive closure`：200 组随机 DAG 与 Warshall 闭包全对。
4. 跨 checkpoint 回滚恢复 —— `layered checkpoints and precise rollback`：rollback(1) 精确撤销最近一层；越界返回 ROLLBACK_RANGE 且状态不变。
5. 重复 id、缺端点、负 k 报 INVALID_INPUT —— `invalid inputs are rejected` 及 CLI 端到端 `cli processes jsonl replay`。

## 规模冒烟（4000 事件 / 4099 边 / 4000 节点 SCC）

```
query e0->e3999: REACHABLE
query e3999->e0: NOT_REACHABLE
scc size: 4000
rollback: OK
after rollback scc: []
elapsed ms: 823
```
