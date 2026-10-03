# incremental-derive

实验室数据流水线用的依赖图派生值增量维护库及 CLI。Node.js 22，仅标准库，离线可用。

## 运行

```sh
node src/cli.js < req.json > res.json
node --test        # 运行全部测试
```

## 请求格式

```json
{
  "state": {
    "nodes": [
      { "id": "a", "kind": "source", "value": 1 },
      { "id": "b", "kind": "derived", "op": "sum", "inputs": ["a"] }
    ],
    "edges": [{ "from": "a", "to": "b" }]
  },
  "transactions": [
    { "id": "t1", "undoTag": "u1", "ops": [{ "type": "setSource", "node": "a", "value": 2 }] }
  ]
}
```

- 节点：`kind` 为 `source`（带初值 `value`）或 `derived`（带 `op`，值为计算结果）。
- 派生算子：`sum`、`min`、`max`、`avg`（数值输入）、`concat`（字符串输入，按输入节点 id 升序拼接）。
- 边可用 `state.edges` 或 derived 节点上的 `inputs` 数组声明，两者等价合并。
- 初始 derived 值一律由引擎全量重算，忽略请求中携带的值。

## 事务操作

| op | 字段 | 说明 |
| --- | --- | --- |
| `setSource` | `node`, `value` | 更正源值 |
| `addEdge` | `from`, `to` | 新增输入边（`to` 必须为 derived） |
| `removeEdge` | `from`, `to` | 删除输入边 |
| `addNode` | `node`（可带 `inputs`） | 新增节点 |
| `removeNode` | `node` | 删除节点及关联边 |
| `undo` | `undoTag` | 撤销 |

## 语义

- **增量失效**：源值更正后，失效仅沿出边传播；按确定性拓扑序重算（Kahn，就绪集同层按 id 升序），结果中的 `recomputed` 即实际重算顺序。
- **原子性**：任一 op 失败（如 `addEdge` 引入环返回 `E_CYCLE`），整个事务回滚，不得部分生效；结果携带回滚后状态 `state`。
- **非法计算**：返回 `E_DERIVE`（如 `min`/`max`/`avg` 空输入、类型不匹配）。错误节点及其后代标记 `blocked: true`（值置 `null`），其他分支不受影响；事务本身成功。`sum` 空输入为 `0`，`concat` 空输入为 `""`。
- **撤销**：`undo` 按 `undoTag` 恢复图结构与值到该标签最早事务之前（多事务同标签等价于逆序撤销），该点之后的撤销记录一并失效。标签不存在返回 `E_UNDO_TAG`，状态不变。
- **版本证书**：每个成功事务 `version` 递增；`certificate` 为 `{version, nodes, edges}` 规范化序列化的 SHA-256，是状态的纯函数，与增量路径无关。

## 响应格式

```json
{
  "ok": true,
  "results": [
    {
      "id": "t1", "ok": true, "version": 1,
      "certificate": "<sha256>",
      "affected": [{ "node": "b", "before": {"value": 1, "blocked": false}, "after": {"value": 2, "blocked": false} }],
      "recomputed": ["b"],
      "errors": [{ "code": "E_DERIVE", "node": "c", "message": "..." }]
    }
  ],
  "final": { "version": 1, "certificate": "<sha256>", "state": { "version": 1, "nodes": [], "edges": [] } }
}
```

失败事务：`{ "id", "ok": false, "error": { "code", ... }, "state": <回滚后状态> }`。

## 错误码

- `E_CYCLE`：边引入环（事务回滚）。
- `E_DERIVE`：非法计算（节点及后代 blocked，事务不回滚）。
- `E_UNDO_TAG`：撤销不存在的标签（事务回滚）。
- `E_UNKNOWN_NODE` / `E_BAD_OP`：操作引用缺失节点或非法操作（事务回滚）。
- `E_PARSE` / `E_BAD_REQUEST`：CLI 输入非法。

## 结构

- `src/common.js`：算子求值、规范化序列化、版本证书。
- `src/engine.js`：增量引擎（失效传播、拓扑重算、回滚、撤销）。
- `src/reference.js`：枚举参考实现（每事务清空后全量重算），供验收对照。
- `src/cli.js`：CLI 入口。
- `test/`：`node:test` 测试，含 ≤8 节点随机枚举对照（值、差分集合、证书）。
