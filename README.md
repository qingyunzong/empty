# recall-dag

从事件 DAG 反推受影响批次的单机离线库与 CLI。Node.js 22，仅标准库
（`node:crypto` / `node:fs` / `node:test` 等），零依赖。

## 核心机制

- **DAG → 自动机正向编译**：`edge{from,to,ver}` 编译为前向邻接表（状态=节点，
  迁移=边），反向链接同步维护，召回查询沿反向可达性取证。
- **影响锥增量扩散**：每个节点维护 `support`（当前受影响父节点的入边数）。
  `affected(n) ⟺ bad(n) ∨ support(n) > 0`。插入边只在父节点受影响时向下扩散；
  删除边递减支持计数，计数归零且非 bad 才移出锥——多父批次必须在**所有**
  支持消失后才移出（引用计数语义，DAG 上与反向 BFS 精确一致）。
- **证书**：每个召回结论附 `cert = { node, path, edges[{from,to,ver}],
  stateHash, queryHash }`。`queryHash = sha256("query\n" + node + "\n" +
  stateHash)`，`stateHash` 提交当前全部边（含版本）与 bad 集合。
  `verifyCertificate(events, cert)` 离线重放事件日志，定位到相同状态哈希的
  查询点，逐边校验路径与版本，并确认终点仍在锥内。
- **版本地板**：每条边记录历史最高版本（删除后仍保留），版本回退即报错。

## 输入格式（JSONL）

```jsonl
{"edge":{"from":"R1","to":"M1","ver":1}}
{"delEdge":{"from":"M1","to":"B1"}}
{"markBad":{"node":"R1"}}
{"query":{"node":"B1"}}
```

## 输出

每个 `query` 事件输出一行：

```json
{"type":"result","query":"B1","affected":["B1","B2"],"coneSize":2,"cert":{...}}
```

`affected` 为当前全部受影响节点（排序），`coneSize` 为其大小；查询节点
未受影响时 `cert` 为 `null`。

## 错误与退出码

| 错误 | code | 退出码 |
|---|---|---|
| 边成环（含自环） | `CYCLE` | 11 |
| 版本回退 | `VERSION_REGRESSION` | 11 |
| query 未知节点 | `UNKNOWN_NODE` | 11 |
| delEdge 不存在（状态哈希不变） | `EDGE_NOT_FOUND` | 11 |
| JSON 解析 / 文件读取失败 | — | 2 |

## 运行

```bash
node --test                          # 测试
node cli.js trace.jsonl              # 处理事件流
node cli.js --verify trace.jsonl     # 处理并离线重放校验全部证书
```

## 实测结果（2026-10-05, Node v22.22.1）

`node --test`：测试文件通过（`# pass 1, # fail 0`），文件内 7 个子测试全部 ok：

```
ok 1 - multi-parent batch removed only after all supports gone
ok 2 - shortcut insertion expands cone with exact coneSize
ok 3 - random DAG ops match explicit reverse BFS
ok 4 - certificate replay matches current library; tampering rejected
ok 5 - delEdge on missing edge errors without mutating state
ok 6 - cycle, version regression, unknown query node -> exit code 11
ok 7 - runTrace emits affected/cert/coneSize and verifies offline
```

`node cli.js example.jsonl`（R1 污染，B1 有两个父批次 M1/M2）：

```
{"type":"result","query":"B1","affected":["B1","B2","M1","M2","R1"],"coneSize":5,"cert":{"node":"B1","path":["R1","M1","B1"],...}}
{"type":"result","query":"B1","affected":["B1","B2","M1","M2","R1"],"coneSize":5,"cert":{"node":"B1","path":["R1","M2","B1"],...}}   ← 删 M1->B1 后仍受影响
{"type":"result","query":"B1","affected":["B2","M1","M2","R1"],"coneSize":4,"cert":null}                                              ← 所有支持消失后移出
```

`node cli.js --verify example.jsonl`：三条证书全部 `{"type":"verify","node":"B1","ok":true}`。

成环输入：`{"error":"CYCLE","message":"edge B->A would close a cycle"}`，退出码 11。

## 验收对照

1. 多父批次所有支持消失后才移出 → 测试 1（引用计数，逐边删除验证）
2. 插入捷径扩大影响锥且 coneSize 精确 → 测试 2（3 → 6 → 3）
3. n≤8 随机 DAG 对照显式反向 BFS → 测试 3（150 轮 × 60 步随机增删/markBad，每步比对）
4. 证书重放与当前库一致 → 测试 4 + `--verify`（篡改 path/ver/queryHash 均被拒绝）
5. delEdge 不存在报错且状态哈希不变 → 测试 5
