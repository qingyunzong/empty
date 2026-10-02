# explree — 层级预算冻结与回滚核验

Node.js 22 标准库实现（无第三方依赖）。预算组织为树：子节点持有额度时，所有祖先同步增加占用；`release`/`cancel` 沿同一路径精确恢复。

## 库（`src/tree.js`）

```js
const { BudgetTree } = require('./src/tree');
const tree = new BudgetTree({ nodes: [
  { id: 'root', parent: null, capacity: 100 },
  { id: 'a', parent: 'root', capacity: 60 },
]});
tree.reserve('b1', [{ node: 'a', amount: 30 }]); // 原子批次，可含多个节点
tree.settle('b1');   // 持有 -> 已用
tree.cancel('b2');   // 撤销整批
tree.read('root');   // { direct, aggregate } 直接值 + 含后代汇总值
tree.freeze('a'); tree.unfreeze('a');
```

- 一批 `reserve` 中任一节点余额不足（含祖先容量）、节点冻结或存在环 → 整批拒绝，无部分占用。
- 错误码：`INVALID_TREE`（环、重复节点、未知父节点、未知节点）、`INVALID_BATCH`（重复/未知批次、非法金额）、`INSUFFICIENT_BALANCE`、`NODE_FROZEN`。
- `stateHash()`：规范化状态快照的 SHA-256。

## CLI

```
node bin/explree.js tree.json actors.json
```

枚举保留各参与者顺序的所有交错（按参与者 id 字典序）：

- 全部安全 → 输出安全证书（交错数、步数、唯一状态数、证书哈希），退出码 0。
- 发现违规 → 输出字典序最小反例（操作前缀、失败原因、祖先占用链、状态哈希），退出码 1。
- 输入非法 → `INVALID_TREE` / `INVALID_ACTORS`，退出码 2。

操作可带 `"expect": "ok" | "reject"` 断言该步必须成功/被拒绝，违反即构成反例。

## 测试

```
node --test
```

- `test/tree.test.js`：验收 1–3（兄弟批次互不影响、深层超额整批回滚、环/重复批次/未知节点拒绝）。
- `test/explorer.test.js`：交错枚举顺序、证书、字典序最小反例。
- `test/crosscheck.test.js`：深度 2、≤4 步全部操作序列（22620 条）与独立参考模型逐步对照。
- `test/cli.test.js`：CLI 证书/反例/非法输入端到端。
