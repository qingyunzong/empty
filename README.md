# hierarchical-settlement

离线层级结算撤销库及 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- 结算组形成树；子组的 `amount` 从父组预算中预留（`parent.reserved`）。
- 状态机：`OPEN → PREPARED → SETTLED`，`OPEN/PREPARED → CANCELLED`，
  撤销被阻塞时进入 `PARTIAL`。`SETTLED`/`CANCELLED` 为终态。
- 提交（commit）后，子组预留转为父组的 `spent`（已消耗，不可归还）。
- 撤销（cancel）级联：仅撤销未独立 `SETTLED` 的后代并归还其预留；
  已 `SETTLED` 后代保留并在结果的 `blocked` 中列出阻塞原因，
  阻塞路径上的祖先变为 `PARTIAL`（退出码仍为 0，不视为整体失败）。
- 不变式：`reserved == OPEN/PREPARED/PARTIAL 子组 amount 之和`，
  `spent == SETTLED 子组 amount 之和`，`available = amount - reserved - spent >= 0`。

## WAL 与崩溃恢复

`commit`/`cancel` 以两阶段写入 WAL（`wal.log`，JSON 行）：

1. `PREPARE`：含受影响子树快照（state/reserved/spent）与预算影响；
2. 应用变更并原子落盘 `store.json`（tmp + fsync + rename）；
3. `COMMIT`。

若在 `PREPARE` 后、`COMMIT` 前崩溃，下次打开时恢复逻辑用快照回滚该
在途事务（追加 `ROLLBACK` 记录），无部分预算扣减，可重新提交。

## CLI

```sh
node src/cli.js [--data DIR] create --id ID --budget N [--parent ID]
node src/cli.js [--data DIR] prepare ID
node src/cli.js [--data DIR] commit ID
node src/cli.js [--data DIR] cancel ID
node src/cli.js [--data DIR] get [ID]
node src/cli.js [--data DIR] crash --after-prepare ID   # 模拟崩溃，退出码 70
```

数据目录默认 `.settle`，也可用环境变量 `SETTLE_DATA_DIR`。
成功输出 JSON 到 stdout（退出码 0）；错误输出
`{"error":{"code","message"}}` 到 stderr（退出码非 0）。

## 库 API

```js
import { Ledger } from './src/ledger.js';
const ledger = Ledger.open(dir);   // 打开时自动恢复
ledger.createGroup({ id, parentId, amount });
ledger.prepare(id); ledger.commit(id); ledger.cancel(id); ledger.get(id);
```

## 测试

```sh
node --test        # 或 npm test
```

- `test/model.test.js`：参考状态机 + 小型树递归枚举每个节点的允许转移，
  逐步校验不变式与 SETTLED 吸收性。
- `test/acceptance.test.js`：三个验收场景（全 OPEN 撤销、混合树 PARTIAL、
  崩溃恢复后重新提交）。
- `test/cli.test.js`：CLI 的 JSON 输出、退出码、崩溃模拟与恢复。
