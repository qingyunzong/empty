# lab-validity-engine

试剂批次更正驱动的实验有效性增量维护库及 CLI。Node.js 22，仅标准库与
`node:test`，全程离线。

## 领域模型

- **批次 (batch)**：`{ id, concentration, expiry, withdrawn, corrected }`。
  批次在以下情况失效：过期（`expiry <= now`）、浓度被更正
  （`correct_concentration`）、供应商撤回（`withdraw_batch`）。
- **实验结果 (result)**：声明使用的主批次 `batch`、协议版本 `protocol`，
  可动态增删替代批次边（`add_substitute` / `remove_substitute`）。
- **派生节点**：图表（`chart`）与结论（`conclusion`），通过依赖边
  （`deps` / `add_edge`）挂在结果或其他派生节点上。

## 有效性规则（约定结果）

- 结果节点：候选批次 = 主批次 ∪ 替代批次。存在至少一个有效候选时
  `valid`，选择批次为** id 字典序最小**的有效候选；全部失效时 `invalid`，
  失效路径为 `[最小候选批次 id, 结果 id]`。
- 派生节点：所有依赖 `valid` 才 `valid`；否则 `invalid`，失效路径为所有
  失效依赖路径按字典序最小者加上自身 id（如 `["b1","r1","c1","k1"]`）。
- 空协议（`protocol` 为空字符串）：结果直接 `invalid`，原因
  `empty_protocol`，失效路径为 `[结果 id]`。
- 批次失效沿派生实验、图表、结论节点反向可达闭包**增量**传播；
  `lastAffected()` 返回最近一次变更重估的节点集合。

## 错误码

- `E_CYCLE`：`add_edge` 会成环（含自环），操作被拒绝且状态不变。
- `E_REF`：引用未知批次 / 未知节点 / 非结果节点。
- `E_DUP`：重复 id。`E_UNDO`：撤销/恢复栈为空。`E_PARSE`：CLI 输入非法。

## 撤销 / 恢复与证书

- 每个成功变更操作记录检查点，`undo()` / `redo()` 逐步回滚与重做。
- `certificate(id)` 返回：`{ node, kind, status, chosenBatch,
  invalidationPath, stateHash, choices? }`；`choices` 为派生节点依赖锥内
  全部结果节点的批次选择。`stateHash` 为规范化状态（含批次、节点、替代
  边与全部计算结果）的 SHA-256。

## CLI

从 stdin 读取 JSON，向 stdout 写出 JSON：

```sh
echo '{"now":1000,"ops":[
  {"op":"add_batch","id":"b1","concentration":1.0,"expiry":5000},
  {"op":"add_result","id":"r1","batch":"b1","protocol":"p1"},
  {"op":"status","id":"r1"}
]}' | node cli.js
```

- 输入：`{ "now": <epoch ms>, "ops": [...] }`；`expiry` 接受 epoch 毫秒、
  ISO 8601 字符串或 `null`。
- 操作：`add_batch` `withdraw_batch` `correct_concentration` `set_expiry`
  `add_result` `add_node` `add_edge` `add_substitute` `remove_substitute`
  `status` `certificate` `state_hash` `undo` `redo`。
- 输出：`{ "ok": true, "results": [...] }`，每项为
  `{ ok:true, value }` 或 `{ ok:false, error:{ code, message } }`。

## 测试

```sh
node --test > test-results.txt 2>&1
```

- `test/engine.test.js`：单元测试（传播、替代选择、环、撤销、空协议、
  证书、共享批次更正只影响可达闭包）。
- `test/differential.test.js`：≤8 批次、≤8 结果的随机操作序列下，增量
  引擎与每次全枚举所有替代路径的参考实现（`src/reference.js`）逐操作
  对比状态、选择批次、失效路径与状态哈希。
- `test/cli.test.js`：CLI stdin/stdout JSON 协议。
