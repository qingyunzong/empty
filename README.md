# release-manifest-incremental-build

科研数据集发布清单的增量构建库及 CLI。Node.js 22，仅标准库与 `node:test`，全程离线。

## 模型

- **文件节点** `{type:"file", content}`：哈希为 `sha256("file\0" + content)`。
- **制品节点** `{type:"artifact", builder, edges}`：哈希由 builder 名称、输入哈希与按边 id 升序排序的边共同计算（`sha256("artifact\0" + builder + "\0" + builderFn(inputs))`）。
- **发布节点** `{type:"release", edges}`：聚合输入哈希；每个发布节点产出一份发布证书（含输入快照、哈希、blocked 标志与证书摘要）。

内置 builder：`concat`、`first`、`count`、`xor`、`manifest`（见 `src/builders.js`）。

## 事务

事务是一组原子操作，验证失败（如引入环）时整体拒绝、状态不变：

- `upsert_file` `{id, content}` — 新增/更正文件
- `add_artifact` `{id, builder, edges:[{id,target}]}` — 新增/替换制品
- `add_release` `{id, edges}` — 新增/替换发布节点
- `add_edge` / `remove_edge` `{node, edge|edgeId}` — 增删依赖边
- `remove_node` `{id}` — 删除节点

应用事务后系统动态求拓扑序（同层按 id 升序），只重算定义变化或输入哈希/状态实际变化的节点，输出：

- `diff`：`added` / `removed` / `changed` / `blocked`
- `invalidations`：每个被重算节点的失效原因（如 `file-content-changed`、`edge-added:x`、`input-changed:<id>`、`input-removed:<id>`）
- `errors`：失效节点（`E_BUILDER` 未知 builder、`E_INPUT` 依赖缺失）
- `blocked`：因上游失效/被阻断而无法构建的节点（不阻断无关节点）
- `certificates`：发布证书列表

## 回滚

`rollback(txId)` 恢复到该事务之前的快照（同时恢复旧哈希与图结构），并丢弃该事务及其后的所有事务。未知事务 id 返回 `E_TX_NOT_FOUND`。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_CYCLE` | 事务引入依赖环，事务被拒绝 |
| `E_BUILDER` | 制品声明了未知 builder（节点失效，下游 blocked） |
| `E_INPUT` | 边指向不存在的节点（节点失效，下游 blocked） |
| `E_EMPTY` | 空图构建 |
| `E_TX_NOT_FOUND` | 回滚不存在的事务 |
| `E_TX_OPS` / `E_TX_ID` / `E_OP` / `E_NODE` | 事务与操作校验错误 |
| `E_CMD` / `E_INPUT` | CLI 命令与输入 JSON 错误 |

## CLI

`src/cli.js` 从 stdin 读 JSON（`{"commands":[...]}`、命令数组或单个命令对象），向 stdout 写 `{"results":[...]}`：

```sh
echo '{"commands":[
  {"cmd":"transact","id":"t1","ops":[
    {"op":"upsert_file","id":"raw","content":"v1"},
    {"op":"add_artifact","id":"clean","builder":"concat","edges":[{"id":"src","target":"raw"}]},
    {"op":"add_release","id":"rel","edges":[{"id":"main","target":"clean"}]}
  ]},
  {"cmd":"state"},
  {"cmd":"rollback","txId":"t1"}
]}' | node src/cli.js
```

命令：`transact`、`rollback`、`build`（全量重建自检）、`state`、`reset`。

## 库用法

```js
import { Engine } from './src/engine.js';
const engine = new Engine();
const result = engine.transact({ id: 't1', ops: [/* ... */] });
engine.rollback('t1');
```

`src/reference.js` 提供每事务全量重建的参考实现，用于对拍验证。

## 测试

```sh
node --test > test-results.txt 2>&1
```

- `test/engine.test.js` — 行为测试（增量重算、深层文件更正、环、未知 builder、回滚、空构建等）
- `test/property.test.js` — ≤10 节点随机事务序列（含回滚）下，增量引擎与全量重建参考逐事务比较哈希、blocked 集合与差分
- `test/cli.test.js` — CLI stdin/stdout JSON 协议
