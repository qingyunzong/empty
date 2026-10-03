# dataset-release-manifest可以改变游戏

科研数据集发布清单的增量构建库与 CLI。Node.js 22，仅标准库，离线可用。

## 模型

- **文件节点** `putFile`：内容哈希 `sha256("file\0" + content)`。
- **制品节点** `addArtifact`：声明 `builder` 与输入边（文件或其他制品）。
  制品哈希 = `sha256(canonical({type:"artifact", builder, inputs}))`，
  其中 `inputs` 为按 id 升序的 `{id, hash}` 列表。
- **发布节点** `addRelease`：输入为制品/文件；全部输入可用时计算发布哈希，
  任一输入失效则标记 `blocked`，不阻断无关节点。

## 事务操作

`putFile` / `addArtifact` / `removeArtifact` / `addRelease` / `removeRelease` /
`addEdge` / `removeEdge`。每次 `commit(ops, txId?)` 原子应用并触发增量构建，
输出：

- `diff.recomputed`：本次实际重算的制品（拓扑分层，同层按 id 升序）
- `diff.changed` / `added` / `removed` / `releasesChanged`：结果发生变化的节点
- `diff.reasons`：每个制品的重算原因（`added` / `definition-changed` / `input-changed:<id>`）
- `diff.failed`：当前失败制品及错误码
- `errors`：本次构建错误（`E_CYCLE`、`E_BUILDER`、`E_INPUT`、`E_INPUT_FAILED`）
- `blocked`：被阻断的发布节点及其阻断源
- `certificate`：发布证书（版本、事务 id、图哈希、全部节点哈希/状态）

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_CYCLE` | 制品依赖成环 |
| `E_BUILDER` | 未知 builder |
| `E_INPUT` / `E_INPUT_FAILED` | 输入缺失 / 输入制品失败 |
| `E_EMPTY_TRANSACTION` | 空事务（空构建） |
| `E_TX_NOT_FOUND` | 回滚不存在的事务 |
| `E_DUP` / `E_NODE` / `E_EDGE` / `E_OP` | 事务操作校验错误 |

## 回滚

`rollback(txId)` 恢复到该事务提交前的状态（同时恢复旧哈希缓存与图结构），
并丢弃该事务及其后的全部历史。

## CLI

```
node src/cli.js   # 从 stdin 读 JSON（数组、单对象或 NDJSON），逐条输出 JSON 行
```

命令：`transaction`（`id?`, `ops`）、`rollback`（`tx`）、`hash`（`id`）、
`state`、`certificate`。环境变量 `MANIFEST_BUILDERS` 可覆盖内置 builder 列表
（默认 `concat,normalize,aggregate,annotate`）。

## 库用法

```js
import { Manifest } from './src/manifest.js';
const m = new Manifest();
m.commit([{ op: 'putFile', id: 'f0', content: 'raw' }], 'tx-1');
m.rollback('tx-1');
```

`src/reference.js` 提供每事务全量重建的参考实现，测试用它与增量实现逐事务
对比哈希、blocked 集合与差分（≤10 节点、随机事务序列，含回滚）。

## 测试体温检测

```
node --test
```
