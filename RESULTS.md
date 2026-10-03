# RESULTS

环境：Node.js v22.22.1，仅标准库，离线单机。测试命令：`node --test`。

## 测试汇总（真实运行结果）

`node --test`（5 个测试文件，共 35 个用例）：

```
# tests 5        （测试文件数；各文件内用例见下）
# pass 5
# fail 0
# duration_ms 16297.394383
```

逐文件（`node <file>` 直接运行，统计文件内全部用例）：

| 文件 | 用例数 | 通过 | 失败 |
|---|---|---|---|
| test/graph.test.js | 9 | 9 | 0 |
| test/monitor.test.js | 15 | 15 | 0 |
| test/random.test.js | 2 | 2 | 0 |
| test/cli.test.js | 8 | 8 | 0 |
| test/scale.test.js | 1 | 1 | 0 |
| **合计** | **35** | **35** | **0** |

## 验收项对照

1. **链、环、双连通分量桥判定正确** — `test/graph.test.js`：
   链 1-2-3-4 桥=全部 3 边、割点={2,3}；环 1-2-3-4-1 无桥无割点；
   八字形双环共享点割点={3}；K4+尾边桥仅尾边 {(4,5),(5,6)}。
2. **删除造成桥集合变化** — `deletion changes the bridge set`：
   三角形+尾边删 (1,3) 后桥集由 {(3,4)} 变为 {(1,2),(2,3),(3,4)}。
3. **三故障点注入截断字节后 recover 确定** — `test/monitor.test.js`
   `all three fault points recover deterministically`（每点重复 2 次 + 幂等二次恢复）：
   - `after_append`：`{"applied":5,"discarded":1}`，半条 del_edge 被丢弃、边未删；
   - `before_fsync`：`{"applied":4,"discarded":1}`，最后一条记录尾部丢失；
   - `after_index_commit`：`{"applied":5,"discarded":1}`，撕断的 commit 不确认任何操作；
   同一点多次运行结果完全一致，二次 recover `discarded=0`。
4. **n≤10 随机图与删边重算对照** — `test/random.test.js`：30 个种子 × 120 步
   随机增删，逐步与独立朴素重算（并查集数连通分量）对照桥/割点；
   每 25 步 commit 后从日志重放，与内存视图 state_hash 一致。
5. **重复边、未知边、空文件恢复边界** — 重复 add_edge 幂等（OK，边数不变）；
   未知 del_edge → `NO_SUCH_EDGE`；空文件/缺失文件 recover →
   `applied=0, discarded=0`，hash 为空图 hash；自环/非法顶点 → `INVALID_INPUT`；
   完整记录 CRC 错误 → `PERSIST_CORRUPT`。

规模验证（`test/scale.test.js`）：n=300、m≤2000、8000 次增删操作，
周期性查询与 commit+recover 对拍，全部一致，单文件耗时约 2.6 s。

## CLI 实测（真实输出）

```
$ node cli.js ops.jsonl add_edge 1 2     → OK
$ node cli.js ops.jsonl add_edge 2 3     → OK
$ node cli.js ops.jsonl add_edge 3 4     → OK
$ node cli.js ops.jsonl commit           → OK
$ node cli.js ops.jsonl query_bridges    → [[1,2],[2,3],[3,4]]
$ node cli.js ops.jsonl query_articulation → [2,3]
$ node cli.js ops.jsonl add_edge 3 1     → OK        （闭合成环）
$ node cli.js ops.jsonl query_bridges    → [[3,4]]
$ node cli.js ops.jsonl del_edge 9 9     → INVALID_INPUT
$ node cli.js ops.jsonl del_edge 7 8     → NO_SUCH_EDGE
$ node cli.js ops.jsonl crash_sim after_append → OK
$ node cli.js ops.jsonl recover
  → {"applied":4,"discarded":1,"state_hash":"06b29472f9bec478f0b8fb2a770ba02749c5482aa76b4c9c4a78b822a2b855c0"}
$ node cli.js ops.jsonl recover          （幂等）
  → {"applied":4,"discarded":0,"state_hash":"06b29472f9bec478f0b8fb2a770ba02749c5482aa76b4c9c4a78b822a2b855c0"}
```

恢复后日志文件（半条记录已被截断）：

```
{"seq":1,"op":"add_edge","u":1,"v":2,"crc":"a36c542347bfe586"}
{"seq":2,"op":"add_edge","u":2,"v":3,"crc":"bf62fc34b5f5ec0b"}
{"seq":3,"op":"add_edge","u":3,"v":4,"crc":"15bd9e66f8427ac5"}
{"seq":4,"op":"commit","crc":"f6db925c76c78ee4"}
{"seq":5,"op":"add_edge","u":3,"v":1,"crc":"8cea2e7259b8e6ee"}
```
