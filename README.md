# eod-reconcile

日终对账库与 CLI：比较交易流水（ledger）与结算快照（snapshot），差异生成修复任务；
修复 worker 槽有限，任务按商户配额、严重度、截止调度；错误修复可撤销并逐字节恢复旧快照。
Node.js 22，仅标准库，测试使用 `node:test`。

## 核心机制

- **差异分类**（`src/diff.js`）：按 `id` 对齐两边账目，分类为
  `MISSING_IN_SNAPSHOT` / `MISSING_IN_LEDGER` / `AMOUNT_MISMATCH` /
  `CURRENCY_MISMATCH` / `STATUS_MISMATCH` / `ATTRIBUTE_MISMATCH`。
  输入非法（缺 id、金额非有限数、重复 id 等）抛 `BAD_DIFF`。
- **受限调度**（`src/scheduler.js`）：worker 槽有界；优先级 = 严重度降序 → 截止升序 → taskId。
  商户配额限制同一商户并发任务数。槽满时只允许抢占**可撤销**且优先级更低的任务，
  否则抛 `NO_SLOT`。已应用的修复持有槽位，被抢占时先撤销再让位。
- **冲突域与历史线性化**（`src/history.js`）：同一账户同一日（`accountId|day`）构成冲突域。
  事件按 `(lamport, source, seq)` 全序线性化；域内到达事件若不大于该域最后已应用事件，
  抛 `CONFLICT_DOMAIN` 并记入报告的 `conflicts`。
- **封存日与 supersedes 链**（`src/seal.js`）：封存日的迟到流水抛 `SEALED`，
  除非携带 `supersedes` 指向同账户同日、尚未被取代的已有流水，形成取代链。
- **撤销/恢复**（`src/engine.js`）：每次修复保存修复前快照的规范化字节串，
  `undo(taskId)` 逐字节恢复；审计日志以 Merkle 根输出为 `auditRoot`。
- **持久化故障点**（`src/store.js`）：journal 先写 `plan` 后写 `commit`。
  - 故障点 1：写完 plan 未写 commit 崩溃 → 恢复时丢弃该 plan；
  - 故障点 2：commit 后崩溃 → 恢复时重放，按 `taskId` 去重保证幂等；
  - 尾部撕裂写（半行 JSON）恢复时忽略。`state.json` 只是缓存，journal 是真相源。

## 输出与错误码

`engine.report()` / `reconcile` 命令输出：

```json
{ "repaired": ["task-1"], "pending": ["task-2"], "conflicts": [], "auditRoot": "<sha256-hex>" }
```

错误码：`SEALED`、`CONFLICT_DOMAIN`、`NO_SLOT`、`BAD_DIFF`（见 `src/errors.js`）。

## CLI

```sh
node bin/cli.js reconcile --ledger ledger.json --snapshot snap.json \
  [--slots 2] [--quota m1=1,m2=2] [--seal a1:2026-10-04] [--state-dir dir]
node bin/cli.js ingest  --ledger late.json --seal a1:2026-10-04
node bin/cli.js undo    --state-dir dir --task task-1
node bin/cli.js report  --state-dir dir
```

退出码：0 成功；1 业务错误（stdout 输出 `{"error": "<CODE>", ...}`）；2 用法错误。

## 测试

```sh
node --test
```

包含：差异分类单测 + 与独立参考分类器在 n≤8 随机用例（3000 组，种子固定）对照；
调度（配额/优先级/抢占仅限可撤销）；封存与 supersedes；撤销逐字节恢复；
冲突域乱序拒绝；持久化两个故障点与幂等重放；CLI 端到端。
