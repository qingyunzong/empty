# qms-lite

单机离线质量判定库 + CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- 检验站上报测量记录（`report`），之后可补测（再次 `report`）或更正（`correct`）。
- 判定按 `(lotId, testCode)` 二级索引取**最新有效记录**：
  - 测量值在规格区间 `[min, max]` 内 → `OK`
  - 超出规格 → `NG`；同一 `(lotId, testCode)` 连续两次超规格 → `NCR`；回到规格内重置
- 每条记录携带 `clientRecordId`：重复上报幂等，不产生新状态、不写 WAL、不产生新证书。
- 更正记录必须引用被更正的 `correctsRecordId`，记录通过 `prevHash` 形成 SHA256 链式证书。

## 错误

| 场景 | 错误码 | exit |
|---|---|---|
| 测量值越出物理量程 `[absMin, absMax]` | `VALUE_OUT_OF_RANGE` | 1 |
| 测量值非有限数值 | `INVALID_VALUE` | 1 |
| 测试项目不存在 | `UNKNOWN_TEST_CODE` | 1 |
| 更正引用未知记录 | `UNKNOWN_RECORD` | 1 |
| 存储未初始化 | `NOT_INITIALIZED` | 1 |
| WAL 损坏 / 哈希链断裂 / 撕裂写 | `CORRUPTION` | 2 |

注意：超出规格 `[min, max]` 不是错误，是合法判定 `NG`；只有越出物理量程才报错。

## 持久化与崩溃恢复

数据目录包含：

- `catalog.json` — 测试项目目录（规格区间 + 物理量程）
- `wal.log` — 追加式 WAL，每条逻辑提交写两行：`data` 行（含记录、判定、哈希）与 `commit` 标记行，每行写后 fsync
- `state.json` — 增量归并后的状态快照（写临时文件 + fsync + rename）

提交流程：追加 `data` 行并 fsync → **崩溃点 A** → 追加 `commit` 标记并 fsync → **崩溃点 B** → 内存状态归并 → 写快照。

恢复时只重放带有匹配 `commit` 标记的 `data` 记录；未提交的尾部记录被截断，不产生判定。恢复会校验序号连续性、`prevHash` 链与每条记录哈希，任何不匹配按损坏处理（exit 2）。快照损坏时回退到 WAL 全量重放；快照与 WAL 不一致按损坏处理。

## CLI

```
node bin/qms.js init     --dir DIR
node bin/qms.js report   --dir DIR --json '{"clientRecordId":"c-1","lotId":"LOT-A","testCode":"dimension.length","value":10.0}'
node bin/qms.js correct  --dir DIR --json '{"clientRecordId":"c-2","correctsRecordId":"rec-00000001","value":10.5}'
node bin/qms.js status   --dir DIR --lot LOT-A --test dimension.length
node bin/qms.js record   --dir DIR --id rec-00000001
node bin/qms.js certs    --dir DIR
node bin/qms.js verify   --dir DIR [--id rec-00000001]
node bin/qms.js catalog  --dir DIR
```

成功向 stdout 输出 JSON 状态，exit 0；业务错误向 stderr 输出 JSON，exit 1；损坏 exit 2。

## 库 API

```js
import { QmsStore } from './src/store.js';
QmsStore.init(dir);
const store = QmsStore.open(dir);          // 恢复 + 校验
store.report({ clientRecordId, lotId, testCode, value });
store.correct({ clientRecordId, correctsRecordId, value });
store.status(lotId, testCode);
store.verify();                            // 全链校验
store.verify(recordId);                    // 单证书独立校验
```

故障注入测试钩子：`QmsStore.open(dir, { crashHook: (point) => {...} })`，`point` 为 `'dataSync'` 或 `'commitSync'`。

## 测试

```
node --test
```
