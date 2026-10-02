# frozen-ledger

可持久化冻结账本。Node.js 22、仅标准库、单机离线。WAL 三段式提交（意图 → 应用 → 提交标记），支持冻结 / 扣占 / 释放 / 冲正，每次提交校验余额/冻结/可用不变量。

## 运行

```sh
node --test        # 运行全部测试（node:test，无需任何依赖）
node cli.js --help # CLI 用法
```

## 设计

### WAL 记录（`<dir>/wal.log`，JSON Lines，逐条 append + fsync）

| type      | 含义                                             |
| --------- | ------------------------------------------------ |
| `intent`  | 事务意图（key、op、参数），先于任何状态变更落盘   |
| `apply`   | 状态增量（账户 before/after），应用后落盘         |
| `commit`  | 提交标记（含结果），落盘后事务生效                |
| `abort`   | 不变量校验失败时的本地作废标记                    |
| `rollback`| 恢复时对"已应用未提交"增量的自动回滚标记          |

每次 `transact` 的顺序：`intent` →（故障点1）→  tentative apply + 不变量校验 → `apply` →（故障点2）→ `commit` →（故障点3）→ 返回响应。

### 三类故障点与恢复语义

| 故障点             | WAL 状态                 | 恢复结果                                       |
| ------------------ | ------------------------ | ---------------------------------------------- |
| 写意图后           | 只有 `intent`            | **PENDING**：未应用、可重试，绝不判为失败       |
| 写应用后未提交     | `intent`+`apply`         | **自动回滚**：增量不重放，追加 `rollback` 标记  |
| 提交后未响应       | `intent`+`apply`+`commit`| **已生效**：按 `apply` 重放；同键重放幂等返回   |

恢复在 `new Ledger(dir)` 时自动执行，结果在 `ledger.recoveryReport`（`committed` / `rolledBack` / `aborted` / `pending`）。PENDING 键通过 `ledger.pending()` 暴露，用同键重试即可继续。

### 幂等

每个事务携带幂等键 `key`。已提交的键重放直接返回提交时持久化的结果（`status: "duplicate"`），不重复应用、不写 WAL；进程内与重启后均成立。

### 操作

- `open(account, balance)`：开户（含初始余额）。
- `freeze(account, amount)`：可用 → 冻结。
- `debit(account, amount)`：扣占，余额与冻结同时减少。
- `release(account, amount)`：冻结 → 可用。
- `reverse(targetKey)`：冲正。只允许冲正**已提交**的事务（PENDING / 已回滚 / 未知键一律拒绝），按目标增量生成补偿增量，不影响其后的其他事务；同一目标只能冲正一次；`open` 不可冲正。

### 不变量（每次提交前校验，恢复重放时复核）

对所有账户：`balance >= 0`、`frozen >= 0`、`frozen <= balance`（即 `available = balance - frozen >= 0`），且均为安全整数。校验失败则撤销 tentative apply、追加 `abort`、抛 `E_INVARIANT`。

### 错误码

| 代码          | 含义                                   |
| ------------- | -------------------------------------- |
| `E_WAL`       | WAL 打开/追加/fsync 失败               |
| `E_RECOVER`   | WAL 记录损坏或恢复中发现不一致          |
| `E_INVARIANT` | 不变量或领域规则违反（含非法参数）      |
| `E_IO`        | 目录/文件等其他文件系统错误             |

故障注入抛出的 `CrashError` 不属于账本错误，仅用于测试/演示模拟进程崩溃。

## CLI

```sh
node cli.js <dir> open <account> <balance> --key K
node cli.js <dir> freeze|debit|release <account> <amount> --key K
node cli.js <dir> reverse <targetKey> --key K
node cli.js <dir> balance [account]
node cli.js <dir> recover | pending | wal
node cli.js <dir> freeze <account> <amount> --key K --crash-after intent|apply|commit
```

崩溃注入时进程以退出码 70 终止并输出 `{"crash":"<point>"}`，模拟提交后未响应等场景。

## 库 API

```js
const { Ledger, LedgerError, CrashError } = require('./src/ledger');
const ledger = new Ledger(dir, { crashAfter: null }); // 打开即恢复
ledger.transact({ key, op: 'freeze', account: 'a', amount: 100 });
ledger.balanceOf('a');   // { account, balance, frozen, available }
ledger.snapshot();       // 全部账户
ledger.pending();        // PENDING 键
ledger.recoveryReport;   // 恢复报告
ledger.close();
```

## 验收与真实测试结果

测试全部使用 `fs.mkdtempSync` 临时目录，覆盖四条验收标准：

1. 三类故障点注入后恢复结果确定（PENDING 可重试 / 自动回滚 / 已生效且重放幂等）；
2. 同键重复提交幂等（进程内与跨重启）；
3. 冲正只影响已提交区间（PENDING 键拒绝冲正，提交后可冲正；会破坏不变量的冲正被拒绝且状态不变）；
4. 300 个带种子的随机操作（含重复键、随机冲正、每 50 步重启恢复）与内存参考状态机逐步对照。

在 Node v22.22.1 上 `node --test` 的真实输出：

```
ok 1 - crash after intent -> PENDING, retryable, never a failure
ok 2 - crash after apply (uncommitted) -> automatic rollback
ok 3 - crash after commit (response lost) -> effective, replay idempotent
ok 4 - duplicate commit with the same key is idempotent, in-process and across restarts
ok 5 - reversal compensates committed ops only
ok 6 - reversal of a PENDING (recovered) key is rejected until it commits
ok 7 - random op sequence matches in-memory reference model, with restarts
ok 8 - corrupt WAL -> E_RECOVER
ok 9 - unusable directory -> E_IO
ok 10 - invariant violations -> E_INVARIANT and no WAL garbage
# tests 10
# pass 10
# fail 0
```
