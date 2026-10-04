# 结算快照与层级回滚（settlement-snapshots）

Node.js 22、仅标准库（`node:crypto` / `node:fs` / `node:test`）、单机离线。
提供批次层级（祖父-父-子）上的结算快照（savepoint）与回滚能力：库（`src/ledger.js`）+ CLI（`src/cli.js`）。

## 数据模型

- **批次 Batch**：`{ id, parentId, day, status: open|settled|rolledback, createdSeq }`，子批次依赖父批次。
- **交易 Tx**：`{ id, batchId, account, amount, day, seq, status: active|settled|corrected|void, corrects, reverses, correctedBy, reversedBy }`，追加式日志，全局单调 `seq`。
- **快照 Savepoint**：`{ id, batchId, seq, day, hash }`，按 `seq` 划定覆盖范围——`seq <= savepoint.seq` 的交易被保留，之后的进入回滚影响区间。跨日边界的快照天然不含下一日首笔（其 `seq` 更大）。
- **冲正 Reversal**：对已出账（settled）交易生成 `REV-<id>` 反向分录（`amount` 取负、`reverses` 指向原交易），原交易保留并标记 `reversedBy`，不删除历史。
- **更正 Correction**：`corrects` 指向原交易，原交易转为 `corrected`（不计余额），更正交易承载新金额。

## 回滚语义

`planRollback(savepointId, { reverse })` 产出回滚计划，`executeRollback(plan)` 执行：

- **影响区间 affectedRange**：`{ fromSeq, toSeq, days, txCount }`，即目标批次子树内 `seq > savepoint.seq` 的非 void 交易。
- **只清未结算分支**：`active/corrected` 交易置为 `void` 并冲减余额；快照后新建的后代批次置为 `rolledback`。
- **已出账后代必须冲正**：影响区间内存在 settled 交易/批次时，未指定 `reverse` 直接抛 `E_ORPHAN`（携带孤儿清单）；指定 `reverse: true` 时计划内生成冲正分录，执行时追加。
- **禁止悬空恢复**：快照所属批次已被回滚、或祖先链断裂时拒绝恢复（`E_SNAP` / `E_DEPEND`）；计划生成后账本被修改则 `preHash` 失配，执行抛 `E_SNAP`。
- **不得复活被更正覆盖的交易**：影响区间内的更正交易，若其更正目标在回滚后存活，则该更正被**结转保留**（`carryForward`），不随回滚移除；目标被移除时更正一并移除。
- **边界**：回滚影响区间触及已关闭日（`closeDay`）抛 `E_BOUNDARY`；向已关闭日追加交易同样抛 `E_BOUNDARY`。
- **执行前后哈希**：计划携带 `preHash`，执行结果携带 `preHash`/`postHash`（SHA-256，对规范化状态做稳定序列化）。

## 错误码

| 代码 | 含义 | 典型场景 |
| --- | --- | --- |
| `E_SNAP` | 快照无效/悬空恢复/计划过期 | 快照不存在、目标批次已回滚、`preHash` 失配 |
| `E_DEPEND` | 批次/更正依赖被破坏 | 父批次缺失或未结算、重复更正同一交易 |
| `E_ORPHAN` | 已出账后代未冲正 | 计划含 settled 交易但未启用 `reverse`（`error.orphans` 为孤儿清单） |
| `E_BOUNDARY` | 跨越日结边界 | 回滚触及已关闭日、向已关闭日写交易 |
| `E_INVAL` | 一般非法输入 | 重复 id、非法金额 |

## 库 API

```js
import { Ledger, LedgerError, ERR } from './src/ledger.js';

const ledger = new Ledger();
ledger.createBatch({ id: 'G', day: '2026-10-01' });
ledger.createBatch({ id: 'P', parentId: 'G', day: '2026-10-01' });
ledger.addTx({ id: 'T1', batchId: 'G', account: 'alice', amount: 100, day: '2026-10-01' });
ledger.createSavepoint({ id: 'SP1', batchId: 'G' });
const plan = ledger.planRollback('SP1', { reverse: true });
const result = ledger.executeRollback(plan); // { preHash, postHash, ... }
ledger.balances();                           // { alice: 100 }
ledger.hash();                               // sha256 hex
Ledger.fromJSON(JSON.parse(json));           // 持久化恢复
```

## CLI

状态保存在 JSON 文件（`--state`，默认 `ledger.json`），输出为 JSON，错误输出到 stderr 且退出码为 1。

```
node src/cli.js [--state <file>] <command> [options]

  batch create --id <id> --day <yyyy-mm-dd> [--parent <id>]
  batch settle --id <id>
  tx add --id <id> --batch <id> --account <name> --amount <n> --day <yyyy-mm-dd> [--corrects <txId>]
  day close --day <yyyy-mm-dd>
  savepoint create --id <id> --batch <id>
  rollback plan --savepoint <id> [--reverse]
  rollback exec --savepoint <id> [--reverse]
  status
  hash
```

完整演示脚本：`bash scripts/demo.sh`。

## 真实输出

以下为本机（Node v22.22.1）实际运行 `scripts/demo.sh` 的节选输出。

已出账子批次未冲正直接回滚，抛 `E_ORPHAN` 并给出孤儿清单：

```
$ node src/cli.js --state /tmp/settlement-demo-ledger.json rollback plan --savepoint SP1
{
  "error": "E_ORPHAN",
  "message": "settled descendants require reversal before rollback",
  "name": "LedgerError",
  "orphans": [
    "T2"
  ],
  "settledBatches": []
}
exit=1
```

启用冲正后的回滚计划（影响区间 + 孤儿冲正清单 + 执行前哈希）：

```
$ node src/cli.js --state /tmp/settlement-demo-ledger.json rollback plan --savepoint SP1 --reverse
{
  "savepointId": "SP1",
  "targetBatch": "G",
  "reverse": true,
  "affectedRange": {
    "fromSeq": 5,
    "toSeq": 5,
    "days": [
      "2026-10-01"
    ],
    "txCount": 1
  },
  "removals": [],
  "orphans": [
    "T2"
  ],
  "reversals": [
    {
      "id": "REV-T2",
      "batchId": "C",
      "account": "bob",
      "amount": -50,
      "day": "2026-10-01",
      "reverses": "T2"
    }
  ],
  "carryForward": [],
  "removedBatches": [],
  "preHash": "2171cf8b9e01532ad2bacdbd5be0532d39266b7f8a4b6a5c9078cc6806c5f7fc"
}
```

执行结果（执行前后哈希）：

```
$ node src/cli.js --state /tmp/settlement-demo-ledger.json rollback exec --savepoint SP1 --reverse
{
  "plan": { "...": "同上" },
  "execution": {
    "savepointId": "SP1",
    "targetBatch": "G",
    "preHash": "2171cf8b9e01532ad2bacdbd5be0532d39266b7f8a4b6a5c9078cc6806c5f7fc",
    "postHash": "82a2406fea16d0439e7d6c71ad73844b856c3bb241bcc161aaf423887fcd8f91",
    "removedTxs": 0,
    "reversedTxs": 1,
    "carriedForward": 0,
    "removedBatches": []
  }
}
```

执行后 `status` 显示 `T2` 保留为 `settled` 且 `reversedBy: "REV-T2"`，冲正分录 `REV-T2`（amount -50）入账，`balances` 只剩 `{ "alice": 100 }`。

跨日边界：关闭 `2026-10-01` 后，向该日写交易抛 `E_BOUNDARY`；而基于前一日快照的回滚只影响下一日交易（`days: ["2026-10-02"]`），快照不含下一日首笔：

```
$ node src/cli.js --state /tmp/settlement-demo-ledger.json tx add --id T5 --batch G --account alice --amount 1 --day 2026-10-01
{
  "error": "E_BOUNDARY",
  "message": "day 2026-10-01 is closed",
  "name": "LedgerError",
  "day": "2026-10-01"
}
exit=1
```

## 测试

`node --test`（或 `npm test`），本机真实输出：

```
ok 1 - createBatch rejects unknown parent with E_DEPEND
ok 2 - settleBatch requires settled parent (E_DEPEND)
ok 3 - addTx to a closed day fails with E_BOUNDARY
ok 4 - duplicate savepoint id fails with E_SNAP
ok 5 - savepoint on missing batch fails with E_SNAP
ok 6 - rollback of unknown savepoint fails with E_SNAP
ok 7 - stale plan execution fails with E_SNAP
ok 8 - correcting an already corrected tx fails with E_DEPEND
ok 9 - dangling restore: savepoint of rolled-back descendant fails with E_SNAP
ok 10 - corrections of surviving txs are carried forward, not resurrected
ok 11 - correction is rolled back together with its removed target
ok 12 - hash is deterministic and survives JSON round-trip
ok 1 - acceptance 1: grandparent-parent-child rollback clears only unsettled branches
ok 2 - acceptance 2: settled child batch requires reversal before rollback
ok 3 - acceptance 3: cross-day boundary savepoint excludes next day first tx
ok 4 - acceptance 3b: rollback across a closed day fails with E_BOUNDARY
ok 5 - acceptance 4: random small ledgers match per-tx replay reference model
# pass 17 / fail 0
```

验收对照：

1. **三级回滚只清未结算分支** — `test/acceptance.test.js` acceptance 1：G/P/C 三级，快照后的 4 笔未结算交易置 `void`、快照后新建批次 `C2` 置 `rolledback`，已出账的 `T0` 保留。
2. **已出账子批次先冲正再回滚** — acceptance 2：先抛 `E_ORPHAN`（`orphans: ["T2"]`），`reverse: true` 后生成 `REV-T2` 冲正分录再执行。
3. **跨日边界快照不含下一日首笔** — acceptance 3/3b：`sp.seq === T2.seq < T3.seq`，影响区间仅 `["2026-10-02"]`；回滚触及已关闭日抛 `E_BOUNDARY`。
4. **随机小账期对照逐笔重放参考模型** — acceptance 4：40 个确定性种子（mulberry32）随机生成批次树/交易/更正/结算/快照/回滚，库内增量余额与逐笔重放参考模型（`replayBalances`）逐一比对，并校验哈希 JSON 往返一致与「更正不被复活」不变式。
