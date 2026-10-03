# lab-validity

试剂批次更正驱动的实验有效性增量维护库及 CLI。Node.js 22+,仅标准库,全程离线。

## 数据模型

- **批次 (batch)**:`{ id, expiresAt, concentration, status }`。批次在以下情况失效:
  - `status === 'withdrawn'`(供应商撤回,`withdrawBatch`);
  - 浓度被更正(`correctConcentration`,置 `corrected` 标记);
  - 过期(`now >= expiresAt`,时间由 `setNow` 设定)。
- **结果节点 (result)**:`{ id, batchId, protocolVersion, substitutes }`,声明使用的批次、
  协议版本与替代批次边。
- **派生节点**:`derived` / `chart` / `conclusion`,通过 `dependsOn` 依赖其他节点。

## 语义约定

- 结果节点 valid 当且仅当协议版本非空,且候选批次(声明批次 + 全部替代)中至少一个有效;
  多个有效候选时**确定性地选择批次 id 最小者**(`chosenBatch`)。
- 派生/图表/结论节点 valid 当且仅当所有依赖 valid;失效沿依赖链传播,
  `invalidationPath` 为从根因节点到该节点的确定性路径(每层取 id 最小的失效依赖)。
- 空协议(`protocolVersion` 为空)的结果节点 invalid,cause 为 `empty_protocol`;
  空实验(无任何节点)整体 status 为 `valid`。
- 依赖图成环:求值返回 `{ error: { code: 'E_CYCLE', cycle } }`。
- 引用未知批次或未知节点:返回 `{ error: { code: 'E_REF', node, ref } }`。
- 每次 `apply`/`undo`/`redo` 返回 `affected`:证书哈希发生变化的节点集合,
  即被更正实体的可达闭包;闭包外节点证书逐字节不变。
- 证书 `certificate = { nodeId, status, chosenBatch, invalidationPath, stateHash }`,
  其中 `stateHash` 为 sha256,仅依赖该节点有效性相关的子图(候选批次问题、依赖证书哈希链)。
- 撤销/恢复基于事件溯源:`undo`/`redo` 移动事件游标,状态由重放派生。

## 操作 (ops)

`setNow` `addBatch` `correctConcentration` `withdrawBatch` `addResult` `addNode`
`addSubstitute` `removeSubstitute` `addDependency` `removeDependency` `undo` `redo` `evaluate`

## CLI

从 stdin 读取 JSON(顶层 `{ now, ops: [...] }` 或直接是 ops 数组),向 stdout 输出
`{ results, final }`。退出码:解析失败 1,最终求值含 E_CYCLE/E_REF 为 2,否则 0。

```sh
echo '{"now":"2026-01-01","ops":[{"op":"addBatch","id":"B1"},
  {"op":"addResult","id":"R1","batchId":"B1","protocolVersion":"v1"},
  {"op":"withdrawBatch","id":"B1"}]}' | node src/cli.js
```

## 库用法

```js
import { Lab } from './src/lab.js';
const lab = new Lab();
lab.apply({ op: 'addBatch', id: 'B1', expiresAt: '2027-01-01' });
lab.apply({ op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' });
lab.evaluate(); // { error, status, nodes, stateHash }
```

## 测试

```sh
node --test > test-results.txt 2>&1
```

- `test/lab.test.js`:单元测试 + 随机化测试(≤8 批次、≤8 结果),每一步与
  `src/reference.js`(枚举所有替代路径 + 不动点传播的暴力参考实现)比较
  状态、选择批次与失效路径。
- `test/cli.test.js`:CLI 端到端测试。沙箱中孙进程管道 stdio 不可靠
  (spawnSync 出现虚假 EPERM),故通过 shell 重定向驱动 CLI。
