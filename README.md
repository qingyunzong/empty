# pallet-xfer

单机离线批次转移库 + CLI。Node.js 22，仅标准库与 `node:test`，无第三方依赖。

把多个质检批次（lot）从来源托盘原子地转移到目标托盘，可同时设置 `quarantine`
标志；整批转移要么全部可见，要么全部回滚。

## 设计

- **WAL（`wal.log`）**：每行一条 `crc32 + JSON` 记录。事务写入
  `begin → put/xfer 记录* → commit`；提交标记落盘（fsync）即视为已提交。
  末尾撕裂行（无换行结尾）恢复时丢弃；其余任何校验和/格式错误视为损坏
  （`E_CORRUPT`）。
- **MVCC 版本链**：每个批次（内部 uid）一条版本链
  `[{tx, pallet, lot, quarantine}]`，快照按 `txid <= snapshot` 可见。
- **快照隔离**：事务在 `begin` 时取快照；提交时串行校验——批次在快照后未被
  修改、批次仍属于来源托盘（违反均 `E_SNAPSHOT`）、目标托盘唯一性
  （违反 `E_DUP`）。
- **(palletId, lotId) 唯一二级索引**：同一托盘不允许重复 lotId；不同托盘
  各自持有独立状态（同 lotId 可存在于不同托盘）。恢复时从 WAL 重放重建，
  重建中发现冲突即判损坏。
- **崩溃点**：`after_records`（记录已 fsync、commit 未写）恢复后暂定转移
  全部回滚，并把 WAL 截断到最后一个提交块；`after_commit`（commit 已
  fsync、内存未应用）恢复后全部转移可见。

## CLI

```sh
node cli.js init --dir D
node cli.js put --dir D --pallet P1 --lot L1 [--quarantine]
node cli.js transfer --dir D --from P1 --to P2 --lot L1 [--lot L2 ...] \
     [--quarantine] [--crash-after records|commit]
node cli.js state --dir D
```

输入输出均为 JSON。退出码：业务错误（`E_DUP`/`E_SNAPSHOT`/`E_NOT_FOUND`/
`E_INVAL`/`E_USAGE`）→ 1；WAL 损坏（`E_CORRUPT`）→ 2；模拟崩溃
（`E_CRASH`）→ 3。

## 库 API

```js
import { Store } from './src/store.js';
const store = Store.init(dir);          // 或 Store.open(dir)（含恢复）
store.put('P1', 'L1', { quarantine: false });
store.transfer('P1', 'P2', ['L1'], { quarantine: true, crashPoint: null });
const tx = store.begin();               // 显式事务（快照隔离）
tx.transfer('P1', 'P2', ['L1']);
tx.commit();                            // 可能抛 E_SNAPSHOT / E_DUP
store.dump();                           // { txid, pallets, index }
```

## 测试

`node --test`（真实运行结果，Node v22.22.1）：

```
ok 1 - test/cli.test.js
ok 2 - test/enumeration.test.js
ok 3 - test/transfer.test.js
# tests 3
# pass 3
# fail 0
```

共 13 个子测试全部通过，覆盖三条验收：

1. `test/transfer.test.js`：三批次转移在 `after_records` 崩溃，重启后来源、
   目标、隔离标志与索引均保持转移前状态；`after_commit` 崩溃则全部可见。
2. `test/transfer.test.js`：两事务并发把同批次移到不同托盘，先提交者成功、
   后者 `E_SNAPSHOT`；目标已有同 lotId 返回 `E_DUP`。
3. `test/enumeration.test.js`：对 ≤3 批次、2 托盘枚举转移/崩溃历史
   （2 批次×深度 2 共 1168 个、3 批次×深度 1 共 312 个），恢复后状态与
   朴素"仅保留完整提交块"的 WAL 重放参考逐一深比较。
