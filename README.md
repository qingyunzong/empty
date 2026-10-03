# budget-mvcc

单机离线的实验机时预算账本：MVCC 事务存储（快照隔离 + 提交时冲突检测 +
条件写）+ WAL 崩溃恢复 + CLI。Node.js 22，仅用标准库，测试用 `node:test`。

## 设计

**MVCC（`src/store.js`）**
- 每个已提交事务为其写集中的每个键写入一个以 commit txid 标记的新版本。
- 读事务在快照上读：只见 txid ≤ 快照的版本（快照隔离）。
- 写事务提交时校验：写集（含条件扣减键）中任一键出现比快照更新的已提交
  版本 → `CONFLICT`（first-committer-wins）。
- 预算扣减是条件写：事务内用 `tx.debit()` 声明扣减量，提交时针对最新已提交
  余额校验不为负，否则整个事务以 `BUDGET_EXCEEDED` 中止，无任何部分生效。
- 提交经内部锁串行化：并发扣同一账户按串行顺序判定，不会透支。

**WAL（`src/wal.js`）**
- 每个事务一条 commit 记录：`magic | len | crc32 | JSON payload`（含全部写集）。
- 提交 = 整条记录写入 + fsync；先写 WAL 再应用内存版本。
- 恢复时顺序重放，遇到第一条不完整/校验失败的记录即停止并截断尾部——
  写了一半的 commit 记录被整体忽略，账户余额与占用记录同生同灭。

**原子性**：扣减与资源占用记录在同一个事务的写集中，共享同一条 WAL
commit 记录，因此两者要么都持久、要么都消失。

## CLI

```
node cli.js [--data-dir DIR] <command> [args]
  create-account <name> <balance>   创建预算账户
  debit <name> <amount> [note]      事务扣减并写占用记录（CONFLICT 自动重试 5 次）
  balance <name>                    查询余额
  usage [name]                      列出占用记录（可按账户过滤）
  history                           列出已提交事务
```

错误约定（stderr 输出 `ERROR <CODE> ...`，退出码非零）：

| 代码 | 退出码 | 含义 |
|---|---|---|
| `NO_ACCOUNT` | 2 | 账户不存在 |
| `CONFLICT` | 3 | 并发写冲突，可重试 |
| `BUDGET_EXCEEDED` | 4 | 余额不足，事务整体中止 |
| `ACCOUNT_EXISTS` | 5 | 账户已存在 |

## 测试

`node --test`（或 `npm test`）。覆盖：

- `test/store.test.js` — 快照隔离；写集相交 → CONFLICT；BUDGET_EXCEEDED
  无部分生效；NO_ACCOUNT；重开后状态持久。
- `test/wal-crash.test.js` — **验收场景 (2)**：commit 记录写一半时崩溃，
  恢复后余额与占用记录同无；完整记录写完才崩溃则同有；torn tail 被截断后
  新事务可继续提交。
- `test/concurrency.test.js` — **验收场景 (1)**：余额 100，两个并发事务
  各扣 80，恰一个成功，余额 20 且恰有一条 80 的占用记录；**验收场景 (3)**：
  30 轮随机并发扣减（确定性种子），最终余额必属于同一扣减多重集全部串行
  调度可达余额集合，且占用记录总额与已扣预算严格一致、余额不为负。
- `test/cli.test.js` — CLI 端到端（进程内调用 `run()`，每次调用重新打开
  数据目录，等价于独立进程；沙箱环境无法 spawn 带子进程管道）。

## 真实测试结果

在本机（Node v22.22.1）执行 `node --test`，连续 3 轮全部通过：

```
ok 1 - test/cli.test.js
ok 2 - test/concurrency.test.js
ok 3 - test/store.test.js
ok 4 - test/wal-crash.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 2284.605955
```
