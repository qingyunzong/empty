# incder — 依赖图派生值增量维护库及 CLI

面向实验室数据流水线的增量计算引擎。节点分 `source` 与 `derived`，
derived 节点支持 `sum`、`min`、`max`、`avg`、`concat` 五种计算，输入边可动态增删。
源值更正后，失效仅沿出边传播，按动态拓扑序确定性重算（Kahn 分层，同层按 id 升序）。
仅使用 Node.js 22 标准库与 `node:test`，全程离线。

## 使用

```bash
node src/cli.js < req.json > res.json   # CLI
node --test                             # 运行全部测试
```

库用法：

```js
import { Engine, runRequest } from './src/graph.js';
const engine = new Engine(initialState);
const result = engine.applyTransaction(tx);
// 或一次性处理整个请求：
const response = runRequest(request);
```

## 请求格式

```json
{
  "state": {
    "nodes": [
      { "id": "a", "kind": "source", "value": 1 },
      { "id": "s", "kind": "derived", "op": "sum", "inputs": ["a"] }
    ],
    "edges": [{ "from": "a", "to": "s" }]
  },
  "transactions": [
    { "id": "t1", "undoTag": "u1", "ops": [{ "type": "setSource", "node": "a", "value": 10 }] }
  ]
}
```

- 初始 `state.nodes`：source 带 `value`；derived 带 `op`，可用 `inputs` 数组声明输入边
  （与顶层 `edges` 等价，可混用）。
- 每个事务：`id`、`ops`、`undoTag`（可选，用于撤销）。

### 操作（ops）

| type         | 字段                          | 说明                                   |
| ------------ | ----------------------------- | -------------------------------------- |
| `setSource`  | `node`, `value`               | 更正源值；仅其出边后代失效             |
| `addEdge`    | `from`, `to`                  | 目标必须是 derived；成环则整事务回滚   |
| `removeEdge` | `from`, `to`                  | 删除后旧后代不再失效                   |
| `addNode`    | `node`（同初始节点格式）      | 动态加节点                             |
| `removeNode` | `node`                        | 连带删除关联边                         |
| `undo`       | `tag`                         | 按 undoTag 逆序（栈式）恢复图和值      |

### 派生计算规则

- `sum`：数值求和，空输入为 `0`。
- `min` / `max` / `avg`：数值输入，空输入报 `E_DERIVE`。
- `concat`：输入全为字符串时拼接、全为数组时扁平连接，空输入为 `""`，混合类型报 `E_DERIVE`。
- 输入按输入节点 id 升序取值（保证 concat 确定性）。
- 非数值输入参与数值计算报 `E_DERIVE`。

## 响应格式

```json
{
  "results": [
    {
      "id": "t1",
      "status": "ok",
      "affected": ["s"],
      "diffs": [{ "node": "s", "before": { "value": 1, "blocked": false }, "after": { "value": 10, "blocked": false } }],
      "blocked": [],
      "deriveErrors": [],
      "certificate": { "version": 1, "digest": "<sha256>" }
    }
  ],
  "state": { "version": 1, "nodes": [], "edges": [] },
  "certificate": { "version": 1, "digest": "<sha256>" }
}
```

- `affected`：本事务失效并重算的 derived 节点，按重算顺序（拓扑分层、同层 id 升序）。
- `diffs`：值或 blocked 状态发生变化的节点（含被写入的 source），前后差分。
- `certificate`：版本证书。`version` 随每个已提交事务单调递增（失败事务不计）；
  `digest` 为规范化状态（节点、边、值按 id 排序）的 SHA-256，内容寻址、可复现。

## 错误语义

- `E_CYCLE`：任一边引入环。事务整体回滚、不得部分生效，响应携带回滚后 `state`，版本不变。
- `E_DERIVE`：非法计算（空输入 min/max/avg、类型错误、输入被阻塞）。事务其余部分正常提交；
  错误节点及其后代标记 `blocked`（值置 null），其他分支不受影响；阻塞源修复后自动解除。
- `E_UNDO`：撤销不存在或不在栈顶的 undoTag。事务无效果。
- `E_OP`：非法操作（未知节点、setSource 作用于 derived、目标非 derived 等），事务回滚。
- `E_INPUT`：请求 JSON 无法解析。

撤销为栈式语义：`undo` 仅当给定 tag 位于撤销栈顶时成功，恢复该事务提交前的图和值；
含 undo 的事务自身失败时，撤销栈同样回滚。

## 测试

- `test/enumeration.test.js`：≤8 节点随机图与随机事务序列（含成环尝试与撤销），
  每事务与“清空后全量重算”的独立参考实现（`test/helpers/reference.js`）比较值、差分集合与版本证书。
- `test/incremental.test.js`：更新源仅后代失效；删边后旧后代不再失效；重算顺序确定性；证书确定性。
- `test/errors.test.js`：成环回滚、空输入、孤立 derived、E_DERIVE 阻塞传播、撤销不存在/乱序标签。
- `test/cli.test.js`：CLI 端到端与库一致性。
