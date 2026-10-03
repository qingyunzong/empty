# netting-ledger

多边结算轧账库与 CLI。Node.js 22 标准库实现，测试使用 `node:test`。

## 数据模型

- 条目：`{ entryId, payer, payee, amount, status }`，`status ∈ pending | cancelled | settled`，`amount` 为正整数（最小货币单位）。
- `submit`：重复 `entryId` 幂等，返回已存在条目，不改账、不追加日志。
- `cancel`：仅允许 `pending`；已轧账/已取消 → `ENTRY_NOT_PENDING`；不存在 → `ENTRY_NOT_FOUND`；拒绝时不改账。
- `settle`：按参与者计算净额（净额 = 应收 − 应付），原子把全部参与条目置 `settled`。

## 存储与崩溃恢复

每个 `ledger.json` 对应一组文件：

| 文件 | 作用 |
| --- | --- |
| `ledger.json` | 快照（含 `logSeq`） |
| `ledger.json.tmp` | 快照临时文件 |
| `ledger.json.watermark` | durableWatermark：`{ snapshotHash, logSeq }` |
| `ledger.json.log` | 追加式变更日志（JSONL，每条带单调 `seq`，写后 fsync） |

`settle` 提交流程：

1. 快照写临时文件并 fsync
2. **故障点 `beforeRename`**
3. `rename` 临时文件 → `ledger.json`，目录 fsync
4. 追加 `settle` 日志记录并 fsync（原子提交点）
5. **故障点 `afterRename`**
6. 写 durableWatermark 并 fsync

恢复规则：

- watermark 有效且快照哈希一致 → 加载快照，重放 `seq > logSeq` 的日志。
- watermark 损坏/缺失 → 忽略快照，重放完整变更日志。
- 快照损坏/哈希不符 → 忽略快照，重放完整变更日志。

因此 `beforeRename` 崩溃后无条目变为 `settled`；`afterRename` 崩溃后重启呈现全部 `settled`（经日志重放）。每个故障点只产生定义内的一种结果。

## CLI

```sh
node src/cli.js submit <ledger.json> <entryId> <payer> <payee> <amount>
node src/cli.js cancel <ledger.json> <entryId>
node src/cli.js run <ledger.json> [--crash settle:POINT]   # POINT ∈ beforeRename | afterRename
node src/cli.js recover <ledger.json>                      # 打印条目与 recoveryHash
```

`--crash` 在指定故障点以退出码 75 模拟进程崩溃。`recover` 输出 `recoveryHash=<sha256>`（规范化状态的 SHA-256）。

## 测试

```sh
node --test 2>&1 | tee test-result.txt
```

覆盖：幂等重复提交、取消已轧账条目拒绝且不改账、两个故障点的进程内与真实子进程崩溃、watermark/快照损坏恢复，以及 ≤6 条目共 675 个用例（全部崩溃点 × 取消子集的正/逆序）与独立模型的逐哈希对照。恢复哈希真实记录在 `test-result.txt`。
