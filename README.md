# formal — 训练启动会合协调库

`formal` 是一个确定性的 Go 会合（rendezvous）状态机，供训练启动流程在成员加入、超时、故障和重连时维护一致的成员视图、代次（generation）和 rank。

## 协议语义

- **成员表**：存活成员按 `MemberID` 字典序排序，rank 等于表中的下标，因此同一代次内 rank 唯一且连续（`0..n-1`）。
- **代次**：加入、重连、故障上报或截止超时都会改变成员视图并开启新代次。旧代次中已收到的确认不会带入新代次。
- **确认**：`Ack(member, generation, now)` 只接受“当前代次 + 本代成员 + 严格早于截止时间”的确认。
- **封闭**：当代次内全体成员都在截止前确认时，代次立即变为 `committed`。
- **超时**：截止时仍未确认的成员被视为故障并移除；剩余成员开启新代次，必须重新确认。
- **迟到确认**：针对旧代次的确认返回 `ErrStaleGeneration`，不会修改任何当前状态。重连与截止交错时也不会跨代混合确认。
- **确定性**：所有方法显式接收调用方时间，协调器不读取墙上时钟，因此同一事件序列可精确重放。

代次只有在 `Current` 返回的成员集合上才具有“当前”含义。`History` 保留所有已开启代次的最终快照；旧的已封闭代次仍会出现在历史中，但不会被重新激活。

## 使用示例

```go
coordinator, err := formal.New(formal.Config{
    GenerationTimeout: 10 * time.Second,
})
if err != nil {
    return err
}

now := time.Now()
if err := coordinator.Join("worker-0", now); err != nil {
    return err
}
if err := coordinator.Join("worker-1", now.Add(time.Second)); err != nil {
    return err
}

generation, ok := coordinator.Current()
if !ok {
    return errors.New("no rendezvous generation")
}
for _, member := range generation.Members {
    fmt.Printf("member %s rank %d generation %d\n",
        member.ID, member.Rank, generation.Number)
}

// Workers exchange configuration, then confirm the exact generation they
// observed. A confirmation for any other generation is rejected.
if err := coordinator.Ack("worker-0", generation.Number, now.Add(2*time.Second)); err != nil {
    return err
}
if err := coordinator.Ack("worker-1", generation.Number, now.Add(3*time.Second)); err != nil {
    return err
}
```

典型启动循环：

1. 每个进程调用 `Join`；协调器返回新一代成员表及 rank。
2. 进程按 rank 交换启动配置。
3. 进程用观察到的代次号调用 `Ack`。
4. 协调器在最后一个确认到达时封闭代次；启动流程读取 `Current()` 的 `committed` 视图。
5. 超时或故障后，协调器自动产生新代次；进程必须对新代次重新确认。故障进程恢复后调用 `Reconnect`。

## 错误

- `ErrNoGeneration`：尚无任何代次。
- `ErrStaleGeneration`：确认针对已封闭或被替代的旧代次。
- `ErrUnknownGeneration`：确认针对尚未开启的未来代次。
- `ErrNotMember`：确认者不属于目标代次。
- `ErrUnknownMember`：对从未加入的成员执行 `Reconnect` 或 `Fail`。
- `ErrGenerationClosed`：目标代次已封闭但该成员没有历史确认。

## 验证方式

测试包含四层验证：

1. **朴素成员表对照**：对 `{a,b,c,d}` 的所有非空子集、所有加入顺序和所有故障顺序，逐代比较协调器的成员列表与直接排序得到的朴素成员表，核对每个成员的 rank。
2. **故障序列穷举**：对 2～3 个成员，穷举固定深度内 `Join`、`Fail`、`Reconnect`、`Ack`、`Advance` 的所有交错，并分“不同时间戳”和“同一时间戳”两组运行。每一步都将协调器与独立的朴素状态机模型逐代、逐确认对比。
3. **不变量检查**：每个快照都经过 `Generation.Validate`，检查 rank 连续唯一、成员表有序、确认者属于本代、确认时间早于截止时间，以及 `committed` 代次拥有全体成员的确认。
4. **交错回归**：`TestReconnectDeadlineInterleavings` 枚举重连、旧代次迟到确认和截止推进的 6 种顺序，验证任何后续代次都不包含旧确认。

运行：

```sh
go test ./...
go test -race ./...
```
