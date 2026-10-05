# si-mvcc-db — 快照隔离（Snapshot Isolation）事务型关系存储

TypeScript 实现的多表 MVCC 存储，运行时仅依赖 Node.js 内置模块
（`node:test` / `node:assert`，零 npm 依赖）。

## 语义模型

- **全局时间戳预言机**：`commitTs` 单调递增；事务在 `begin()` 时获得
  快照 `startTs = lastCommitTs`，因此快照天然**跨所有表一致**。
- **读自己的暂存写（RYOW）**：写入先进入事务私有暂存区；同事务读先查
  暂存区（含墓碑删除），未提交数据对其他事务不可见（无脏读）。
- **提交仅校验写集（first-committer-wins）**：`commit()` 只检查写集中
  每个 key 的最新已提交版本是否晚于本方快照；读集从不校验，
  因此**写偏斜（write skew）在 SI 下必然可能发生**，并由测试显式锁定。
- **冲突证据**：冲突方收到 `CommitConflictError`，携带结构化
  `ConflictEvidence`（表、key、本方快照 `txnStartTs`、胜出版本的
  `conflictingCommitTs`、已分配的 `attemptedCommitTs`）。
- **屏障历史**：数据库维护全局提交日志（commit barrier history），
  测试从中重建完整版本模型并逐条核对所有观测到的读。

## 布局

- `src/mvcc.ts` — `Database` / `Transaction` / `CommitConflictError` 引擎
- `test/snapshot-isolation.test.ts` — RYOW、无脏读、可重复读、冲突证据、
  跨表一致快照、墓碑删除
- `test/write-skew.test.ts` — 写偏斜显式发生（两个值班医生同时下班，
  不变量被破坏）；对照组：物化共享行后冲突使第二个提交中止
- `test/version-model.test.ts` — 确定性随机负载（4000 步、3 表、12 key）：
  提交屏障单调性、每 key 写写屏障（FCW）、从提交日志重建的完整版本模型
  与存储内部版本链逐条相等、全部观测读与模型按快照回放一致、
  冲突证据必须指向提交日志中的真实条目
- `types/node.d.ts` — 离线环境下替代 `@types/node` 的最小类型声明

## 运行

```sh
npm test   # tsc 编译 + node --test（需要全局 tsc；运行时无依赖）
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出摘要：

```
# tests 3
# pass 3
# fail 0
```

逐条明细（各文件直接运行）：

```
ok 1 - read-your-own-writes: staged writes are visible inside the txn
ok 2 - no dirty reads: uncommitted writes are invisible to other txns
ok 3 - snapshot isolation: reads are repeatable at the start snapshot
ok 4 - commit conflict: first-committer-wins, loser gets structured evidence
ok 5 - commit validation ignores the read set (SI, not serializable)
ok 6 - consistent snapshot spans multiple tables atomically
ok 7 - multi-table write skew across tables is also possible under SI
ok 8 - deletes commit as tombstones and conflict like writes
ok 1 - barrier history and full version model cross-check (randomized)
ok 1 - write skew happens under SI and is explicitly demonstrated
ok 2 - contrast: touching a shared row serializes the same workload
```

共 11 个测试全部通过。
