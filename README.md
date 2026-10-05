# raftsim — 事件驱动的三节点复制日志模拟库

纯 Go 标准库实现（无任何第三方依赖、无真实网络、无 goroutine/定时器）。
所有节点间交互都是**显式消息事件**，由 `Sim` 的 FIFO 队列逐条派发，
每一步都可审计、可复现。

## 设计

- `Message`（`raft.go`）：四类显式事件 —— `RequestVote` / `VoteResp` /
  `AppendEntries` / `AppendResp`，含任期、prevLog 一致性字段、leaderCommit 等。
- `Node`（`raft.go`）：Raft 风格状态机（follower/candidate/leader）。
  - 任期只能在 `setTerm` 中**单调递增**，回退即记录安全违规；
  - 选举要求多数票且候选日志至少与投票者一样新；
  - 提交规则：仅当前任期的条目可凭多数复制提交（Raft §5.4.2）；
  - follower 发现冲突时**截断未提交冲突后缀**再追加；若截断点触及
    已提交前缀立即记录违规（正确性下不可达，作为运行时断言）。
- `Sim`（`sim.go`）：确定性事件队列 + 有向链路割断（`Cut`/`CutBoth`/`HealAll`）
  模拟分区；`Step()` 每次派发一条消息并产出**每步日志**（`Sim.Trace`），
  被分区丢弃的消息也记录为 `DROP`。
- **提交证据**（`CommitEvidence`）：leader 每次推进 commitIndex 时记录
  任期、索引、条目及构成多数的复制集合。
- **安全不变量**（每条消息派发后检查）：
  1. 各节点 commitIndex 单调不减；
  2. 任意两节点已提交前缀逐条一致（已提交前缀不能被覆盖）；
  3. 全局见证的已提交条目一旦写入不可变更。

## 测试

- `raft_test.go`
  - `TestBasicElectionAndCommit`：选举 + 复制 + 多数提交，输出完整每步日志；
  - `TestOldLeaderRecoveryTruncatesUncommitted`：旧主 n1(term 1) 被分区，
    本地堆积未提交写 `B`/`D`；n2 赢得 term 2 并在多数上提交 `C`；恢复后
    n1 的旧任期消息被拒、退位，并**截掉未提交冲突条目**，已提交前缀 `A` 不动；
  - `TestStaleLeaderMessagesRejected`：旧任期 leader 的消息不干扰新任期节点。
- `enumerate_test.go`
  - `TestEnumerateShortPartitionHistories`：枚举全部短分区历史 ——
    3 条无向链路 ⇒ 每阶段 8 种割断掩码，历史长度 1..4，3 种初始 leader，
    共 3 × (8+64+512+4096) = **14040 个历史**；每个历史的每一步都检查
    安全不变量，愈合后必须收敛到同一日志且全部提交。

## 实测结果（go test ./...，go1.27.1 linux/amd64）

```
$ go test ./...
ok  	raftsim	3.422s
```

`go test -v` 关键输出：

```
--- PASS: TestBasicElectionAndCommit (0.00s)
    commit evidence: COMMIT step=11 index=1 entry=(t1,"x") leader=n1 term=1 replicated=[n1 n2]
--- PASS: TestOldLeaderRecoveryTruncatesUncommitted (0.00s)
    commit evidence: COMMIT step=11 index=1 entry=(t1,"A") leader=n1 term=1 replicated=[n1 n2]
    commit evidence: COMMIT step=27 index=2 entry=(t2,"C") leader=n2 term=2 replicated=[n2 n3]
    commit evidence: COMMIT step=37 index=3 entry=(t2,"E") leader=n2 term=2 replicated=[n1 n2]
    step 35: n1 truncates uncommitted conflict at index=2: was [(t1,"B") (t1,"D")], now [(t2,"C") (t2,"E")]
--- PASS: TestStaleLeaderMessagesRejected (0.00s)
--- PASS: TestEnumerateShortPartitionHistories (7.94s)
    enumerated 14040 partition histories (3 initial leaders, lengths 1..4, 8 masks/phase)
    histories exercising uncommitted-conflict truncation: 6088
    total majority-backed commits witnessed: 66043
PASS
ok  	raftsim	7.958s
```

14040 个分区历史、66043 次多数提交，**零安全违规**；其中 6088 个历史
实际走过了旧主未提交冲突截断路径。
