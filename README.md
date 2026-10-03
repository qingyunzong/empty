# dag-recall-trace

事件 DAG 召回追溯库与 CLI。质量工程师标记异常事件节点后，从 DAG 反推可能
受影响的批次：正向加工事件编译为 NFA（节点=状态、边=带版本迁移、markBad
节点=初始状态集），反向邻接同步维护；召回查询 = 影响锥 ∩ query 反向可达
祖先集，每个批次附可离线重放的证书。纯 Node.js 22 标准库，单机离线。

## 运行

```sh
node --test                  # 全部测试
node cli.js trace.jsonl      # CLI：逐行处理 JSONL，query 输出一行 JSON
node cli.js examples/trace.jsonl
```

## 输入格式（JSONL，每行一个操作）

```json
{"edge":{"from":"mix","to":"ferment","ver":1}}
{"delEdge":{"from":"mix","to":"ferment"}}
{"markBad":{"node":"ferment"}}
{"query":{"node":"pack"}}
```

也兼容 `{"op":"edge","from":...,"to":...,"ver":...}` 形式。`#` 开头为注释行。

## 输出（每个 query 一行）

```json
{"affected":["bake","ferment","pack"],"cert":{"query":"pack","queryHash":"…","items":[{"batch":"bake","path":["ferment","bake","pack"],"edges":[{"from":"ferment","to":"bake","ver":1},…]},…]},"coneSize":3}
```

- `affected[]`：受影响批次 = 影响锥 ∩ query 祖先集（反向可达）。
- `cert`：证书。每项含证据路径（污染源→批次→query 节点）、路径上每条边
  的 `{from,to,ver}`、以及查询哈希（对 `{query,affected,bad}` 规范序列化
  后的 SHA-256）。`TraceStore#verifyCert(cert)` 离线重放：逐边核对存在性
  与版本、路径端点（起点为污染源、终点为 query 节点）、重算查询哈希。
- `coneSize`：当前影响锥大小（自污染源正向可达节点数），增量维护、精确。

## 核心机制

- **正向编译**：`TraceStore` 把 DAG 编译为 NFA——`out`/`inn` 双向迁移表，
  `bad` 为初始状态集，`cone` 为可达状态集。
- **增量影响锥**：每个节点维护 `support`（处于锥内的父节点数）。插边时若
  父端在锥内则子端支持 +1 并向下扩散；删边时支持 −1，归零且非污染源才
  移出锥并递归回收——多父批次在所有支持消失前保留（验收 1）。插入捷径
  只扩散新增子锥，`coneSize` 精确（验收 2）。
- **删除不回收仍被其他路径支持的批次**：支持计数而非布尔标记，保证
  `delEdge` 后锥与从头 BFS 完全一致（验收 3 随机对照）。
- **证书**：路径 + 边版本 + 查询哈希，可离线重放验证（验收 4）。
- **状态哈希**：`stateHash()` 对 `{edges,bad}` 规范序列化取 SHA-256；
  失败的 `delEdge` 在修改前抛错，状态哈希不变（验收 5）。

## 错误与退出码

所有输入校验错误（边成环、版本回退、query 未知节点、delEdge 不存在、
markBad 未知节点、非法 JSON/op）均以 **退出码 11** 终止，错误信息写
stderr；缺参数/文件不可读退出码 2。库内抛出 `TraceError`（`exitCode=11`）。

## 测试结果（真实运行，`node --test`，Node v22.22.1）

```
ok 1 - multi-parent batch stays until all supports are gone
ok 2 - shortcut insertion grows cone with exact coneSize
ok 3 - random DAG ops match explicit forward/reverse BFS reference
ok 4 - certificate replays consistently against current store
ok 5 - delEdge on missing edge errors and leaves state hash unchanged
ok 6 - cycle, version rollback and unknown query node are rejected
ok 7 - cli emits query results and exits 11 on input errors
# tests 7
# pass 7
# fail 0
```

验收对照：1→测试 1；2→测试 2；3→测试 3（150 个种子、n∈[2,8]、每种子
40–80 个随机增删/标记/查询操作，与独立正向 BFS + 显式反向 BFS 参考模型
逐操作比对 affected、coneSize 与完整锥）；4→测试 4（含篡改边版本与删减
证书项的负例）；5→测试 5。

CLI 真实退出码（shell 手动验证）：

```
$ node cli.js /tmp/cycle.jsonl      # a→b, b→a
error: edge b→a: creates a cycle        ; exit=11
$ node cli.js /tmp/rollback.jsonl   # ver 2 后重插 ver 1
error: edge a→b: version rollback 2 -> 1; exit=11
$ node cli.js /tmp/unknown.jsonl    # query 未知节点
error: query: unknown node "ghost"      ; exit=11
$ node cli.js /tmp/delmissing.jsonl # delEdge 不存在
error: delEdge a→c: edge does not exist ; exit=11
```

## 文件

- `lib.js` — 核心库：`TraceStore`（增量锥、查询、证书、状态哈希）、`TraceError`。
- `cli.js` — JSONL 驱动 CLI，可 `require`（`main(argv, io)` 返回退出码）。
- `test/trace.test.js` — node:test 验收测试。
- `examples/trace.jsonl` — 示例轨迹（含多父路径与删边后重查）。
