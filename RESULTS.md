# RESULTS

日期：2026-10-04 ｜ 环境：Node.js v22.22.1，离线，仅标准库

## node --test

```
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

各文件子测试（共 25 个，全部通过）：

```
== test/graph.test.js
# tests 8
# pass 8
# fail 0
== test/log.test.js
# tests 10
# pass 10
# fail 0
== test/cli.test.js
# tests 7
# pass 7
# fail 0
```

## 验收点覆盖

1. **链 / 环 / 双连通分量桥判定**：`test/graph.test.js` —— 链 0-1-2-3 全部边为桥、
   割点 {1,2}；环无桥无割点；共享顶点的双三角形割点为共享点、无桥；三角形加悬挂边
   唯一桥为悬挂边。另有 n≤10 随机图与暴力 oracle（删边查连通、删点数分量）对照 60 轮。
2. **删除造成桥集合变化**：`deletion changes the bridge set` —— 删 (0,1) 后桥集由
   [[2,3]] 变为 [[0,2],[1,2],[2,3]]；CLI 工作流测试中 del_edge 后桥集从 [[2,3]] 变 []。
3. **三故障点注入截断字节后 recover 确定**：`test/log.test.js` 与 `test/cli.test.js`
   对 after_append / before_fsync / after_index_commit 各注入半条 del_edge：
   recover 得 applied=已确认变更数、discarded=1，state_hash 与崩溃前一致，半条
   del_edge 未生效（边仍在），二次 recover discarded=0 且 hash 不变（幂等确定）。
4. **n≤10 随机图与删边重算对照**：随机增删后与暴力 oracle 及从边列表全新重放
   （快照重放）逐一比对 bridges / articulation / canonical 完全一致。
5. **边界**：重复边 → INVALID_INPUT；未知边删除 → NO_SUCH_EDGE；空文件 / 缺失文件
   recover → applied=0 discarded=0；仅含半条记录的空日志 → discarded=1 且不应用；
   完整记录校验和错 / seq 断裂 / 日志自相矛盾 → PERSIST_CORRUPT；自环、越界顶点、
   边数超 2000 → INVALID_INPUT。

## 真实 CLI 会话（GRAPH_LOG=/tmp/demo/graph.log）

```
$ node src/cli.js add_edge 0 1
OK
$ node src/cli.js add_edge 1 2
OK
$ node src/cli.js add_edge 2 0
OK
$ node src/cli.js add_edge 2 3
OK
$ node src/cli.js commit
OK
$ node src/cli.js query_bridges
[[2,3]]
$ node src/cli.js query_articulation
[2]
$ node src/cli.js del_edge 2 3
OK
$ node src/cli.js query_bridges
[]
$ node src/cli.js add_edge 2 3
OK
$ node src/cli.js crash_sim after_append
OK
$ node src/cli.js recover
{"applied":6,"discarded":1,"state_hash":"b3fe5a1fba068b09cbc23df2b2ef8d8b07bde7a752e8389a7986896a40ce8f30"}
$ node src/cli.js query_bridges  # torn del_edge NOT applied
[[2,3]]
$ node src/cli.js recover  # idempotent
{"applied":6,"discarded":0,"state_hash":"b3fe5a1fba068b09cbc23df2b2ef8d8b07bde7a752e8389a7986896a40ce8f30"}
$ node src/cli.js del_edge 0 9
NO_SUCH_EDGE
$ node src/cli.js add_edge 2 3  # duplicate
INVALID_INPUT
$ node src/cli.js add_edge 5 5  # self loop
INVALID_INPUT
```

## 规模冒烟（n=300, m=2000, 4000 次增删混合操作）

```
ops=4000 bridges=0 applied=2026 discarded=0
```

每条命令为全量日志重放（O(日志)），单条记录解析+校验约 2µs；
8000 条记录的完整 recover 为亚秒级。
