# 分布式训练成员协调组件

`package formal` 提供并发安全的同步训练成员协调器，供 worker 管理器直接调用。它负责成员代次、rank 分配、step 屏障、旧代次消息拒绝和 checkpoint 可见性门控。

## 核心模型

- **代次（Generation）**：从 1 开始单调递增。每次 `Reconfigure` 冻结当前 step、退休旧代次并创建一个新代次。
- **rank**：按 `Reconfigure` 传入的成员顺序分配 `0..N-1`；需要稳定 rank 时请传入稳定顺序。
- **step 屏障**：每个成员对当前 step 提交一次梯度摘要。只有当前代次全体成员都提交后 step 才前进，且只生成一条单代次的 `StepRecord`。
- **扩缩容**：旧代次未完成的梯度被丢弃，新代次在同一 step 重新开始，因此不会把旧成员的部分梯度带入新代次。已完成 step 永不重开。
- **旧消息拒绝**：梯度、心跳、checkpoint 确认都携带代次。旧代次、被移除成员、过期/超前 step、重复且冲突的梯度、回放或乱序心跳均返回可判定的错误。
- **checkpoint 门控**：`CreateCheckpoint` 只返回 Pending 屏障 ID；`Checkpoint` 仅在全体成员确认后返回 checkpoint。扩缩容会中止 Pending checkpoint，迟到确认无法将其复活；已可见 checkpoint 不可变。
- **审计证据**：`StepHistory` 记录每个已完成 step 的单代次成员集合；`GenerationHistory` 记录冻结 step、丢弃的梯度数和被中止的 checkpoint。

## 使用示例

```go
c, err := formal.New([]formal.MemberID{"worker-0", "worker-1"})
if err != nil {
    return err
}

var digest [32]byte // 实际由梯度内容计算
err = c.SubmitGradient(formal.Gradient{
    Member:     "worker-0",
    Generation: 1,
    Step:       0,
    Digest:     digest,
})

// 所有成员提交后 step 自动前进到 1。
c.SubmitGradient(formal.Gradient{Member: "worker-1", Generation: 1, Step: 0})

checkpointID, err := c.CreateCheckpoint()
if err != nil {
    return err
}
for _, member := range []formal.MemberID{"worker-0", "worker-1"} {
    if err := c.ConfirmCheckpoint(formal.CheckpointAck{
        ID:         checkpointID,
        Member:     member,
        Generation: 1,
    }); err != nil {
        return err
    }
}

// 仅当全体确认后可见。
checkpoint, visible := c.Checkpoint(checkpointID)
```

扩缩容：

```go
transition, err := c.Reconfigure([]formal.MemberID{"worker-0", "worker-1", "worker-2"})
// transition.Generation 是新代次，transition.FrozenStep/StartStep 是冻结并重跑的 step，
// transition.DiscardedGradients 是被丢弃的旧代次部分梯度，
// transition.AbortedCheckpoints 是被中止的 Pending checkpoint。
```

调用方应使用 `errors.Is` 判断 `ErrStaleGeneration`、`ErrStaleStep`、`ErrStaleHeartbeat`、`ErrUnknownMember`、`ErrCheckpointAborted` 等哨兵错误。

## 安全不变量

1. 一个已完成 step 只属于一个代次；`StepHistory` 不会出现同一 step 的跨代记录。
2. 一个 step 的贡献集合只包含该代次全体成员，不会混入旧代次或被移除成员的部分贡献。
3. 新代次开始后，旧代次梯度与心跳全部拒绝，即使消息内容看似合理。
4. Pending checkpoint 在代次变更时永久中止；只有完整确认的 checkpoint 才可读取。
5. 所有入口由同一互斥锁线性化，冻结与消息接收不存在交错窗口。

`TestFailureAndPartitionSequenceNeverMixesGenerations` 用成员故障、分区、消息延迟回放和恢复重入序列验证上述不变量；`TestConcurrentCompletionProducesOneStepRecord` 在 `-race` 下验证并发屏障。

## 验证

```sh
go test ./...
go test -race ./...
go vet ./...
```

协调器为内存组件：故障检测、代次提议、checkpoint 持久化由 worker 管理器负责。`StepHistory`/`GenerationHistory` 当前不设上限，长期运行的控制面应按需做归档。
