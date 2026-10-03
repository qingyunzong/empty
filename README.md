# recon-repair

日终对账与修复库 + CLI。纯 Node.js 22 标准库，无外部依赖，离线可用。

## 场景

日终比较交易流水（ledger）与结算快照（snapshot），差异生成修复任务；
修复 worker 槽有限，任务按商户配额、严重度、截止日调度；错误修复可撤销并
逐字节恢复旧快照。

## 核心机制

- **差异分类**（`src/diff.js`）：`missing_in_snapshot` / `missing_in_ledger` /
  `mismatch`（带字段级定位）/ `duplicate`。主分类器 O(n)（Map），
  `classifyDiffsReference` 为 O(n²) 朴素参考实现，测试对 n≤8 做 5000 组
  随机对照。金额为整数（最小货币单位），浮点直接 `BAD_DIFF`。
- **受限调度**（`src/scheduler.js`）：固定 worker 槽 + 每商户并发配额。
  优先级 = 严重度降序 → 截止日升序 → id 升序。抢占仅允许针对
  `undoable: true` 的较低优先级任务，且不得破坏商户配额；严格模式
  （`strict`）无槽且无可抢占者时抛 `NO_SLOT`。
- **冲突域与历史线性化**（`src/history.js`）：同一账户同一日
  （`account@day`）构成冲突域。域内事件按 (lamport, source, seq) 全序
  线性化。同源且 lamport/seq 单调递增视为干净延续；否则必须显式
  `supersedes: <headId>` 构成链，否则 `CONFLICT_DOMAIN`。
- **封存日**：`seal(account, day)` 后，迟到流水不得改写该日（`SEALED`），
  除非生成指向当前 head 的 supersedes 链。
- **撤销/恢复**（`src/engine.js`）：每次修复前捕获快照字节（按 id 排序的
  规范化 JSON 行），`undo(taskId)` 逐字节恢复旧快照并追加审计记录。
- **审计根**（`src/audit.js`）：哈希链
  `root = sha256(prevRoot || ':' || canonical(entry))`，输出 `auditRoot`。

## 持久化故障点（`src/journal.js`）

追加式日志，每条记录 fsync。两个故障点：

1. 写完 `plan` 未写 `commit` 崩溃 → 恢复时该 plan 被丢弃；
2. `commit` 后崩溃 → 重放必须幂等：按 id 去重，已应用的 id 跳过，
   重复恢复产生完全相同的快照字节。

## 输出与错误码

`reconcile` 输出 `{ repaired, pending, conflicts, auditRoot }`。
错误码：`SEALED`（封存日写入）、`CONFLICT_DOMAIN`（冲突域并发写）、
`NO_SLOT`（无槽且无可抢占任务）、`BAD_DIFF`（非法条目/差异/修复动作）。

## 用法

```sh
node bin/recon.js reconcile --ledger ledger.json --snapshot snapshot.json \
  [--slots N] [--quota N] [--seal acct@YYYY-MM-DD ...] \
  [--journal journal.log] [--recover journal.log] \
  [--undo repair:missing_in_snapshot:txn-1] [--out final.snap]
node bin/recon.js diff --ledger ledger.json --snapshot snapshot.json
```

流水条目可带 `late: true` 与 `supersedes: <eventId>` 标记迟到与链式改写。

## 测试

```sh
node --test
```

最近一次运行（2026-10-03，Node v22.22.1）：5 个测试文件全部通过，
共 37 个测试（cli 5 / diff 9 / engine 8 / history 6 / scheduler 9），0 失败。
覆盖验收项：封存日拒绝（SEALED）、worker 槽抢占只限可撤销任务、
撤销后快照逐字节恢复、n≤8 与参考差异分类器对照（5000 组随机用例）、
plan-未-commit 丢弃与 commit 后幂等重放。

注：沙箱禁止子进程（spawn EPERM），CLI 测试以注入 stdout/stderr 的方式
进程内调用 `run()`；`bin/recon.js` 只是该函数的薄封装。
