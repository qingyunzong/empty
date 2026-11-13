# Kafka 增量分区再均衡协调层

`example.org/dataeng/q0018` 是一个零外部依赖的 Go 包，用于把 Kafka consumer
group 的分区生命周期、输出批次、外部 sink 提交和 offset 提交串成一条可恢复的
事务链。它面向 cooperative-sticky（增量）再均衡：`Assign` 与 `Revoke` 只处理
本次新增或撤销的分区，其余分区继续运行。

## 接入

宿主 Kafka 客户端只需要把回调转成 `Assignment` / `PartitionID`，并提供以下
端口：

- `Reader.Fetch`：从指定分区和 offset 读取，最多 `BatchSize` 条，offset 必须连续。
- `Processor.Process`：把输入记录转换为输出批次，同一输入区间必须确定性。
- `Sink.Submit`：异步或同步地持久化输出批次；`done` 必须且只能调用一次。
- `OffsetCommitter.CommitOffset`：提交 next offset；重复提交必须幂等。
- `Journal.Append/Replay`：事务日志。生产环境使用 `OpenFileJournal`，进程崩溃后可恢复。

```go
coord, err := dataeng.New(dataeng.Config{
    Reader:    reader,
    Processor: processor,
    Sink:      sink,
    Committer: committer,
    Journal:   journal,          // dataeng.OpenFileJournal(path)
    BatchSize: 500,
})

// cooperative rebalance: 只传入新增分区
err = coord.Assigned(ctx, []dataeng.Assignment{{
    Partition: 3, NextOffset: 120, Generation: 7,
}})

// 只传入被撤销的分区；会停止新读取并等待在途提交
err = coord.Revoked(ctx, []dataeng.PartitionID{3})

// 非协作式丢失：立即围栏，不等待
coord.Lost(3)
```

`Assigned` / `Revoked` 对应常见客户端的 rebalance listener 方法名；也可以直接
调用 `Assign` / `Revoke`。`NextOffset` 通常来自 consumer-group 已提交 offset。

## 事务与恢复协议

每个批次严格按以下顺序落盘和提交：

1. `begin`：写入批次 ID、分区、offset 区间和完整输出内容并 fsync；
2. `sink_committed`：外部 sink 持久化接收后写入回执；
3. Kafka `CommitOffset(next)`；
4. `offset_committed`：写入日志；
5. 推进内存 watermark，然后才读取下一批。

`Assign` 在启动 worker 前重放日志，从 assignment offset 开始连续恢复：

- 有 `begin` 无 sink 回执：用同一批次 ID 重新提交，sink 幂等去重；
- 有 sink 回执无 offset：只重提 offset，不重复写 sink；
- 有 offset：直接推进到该批次末尾；
- `fenced` 事件只用于审计，永不推进水位。

批次 ID 只由 `partition:first:next` 组成，不含 generation/epoch，因此重启、
重试以及新旧 owner 重叠时都使用同一个 sink 幂等键。跨版本部署应保持
`BatchSize`（或至少保持批次边界）不变，否则不同边界会生成不同 ID，此时
sink 需要按记录级幂等键额外去重。

## 撤销与围栏

每个分区有独立的 `(generation, epoch)` 租约：

- `Revoke` 先设置 `revoking` 并取消 fetch；当前批次已越过 `begin` 时，使用
  不受撤销取消影响的提交上下文继续完成 sink 回调和 offset 提交，`Revoke`
  等待 worker 退出后才返回。
- 若撤销 deadline 先到，立即递增 epoch 并返回 `ErrRevokeTimeout`；旧
  worker 的迟到回调会写 `fenced` 日志，不提交 offset，也不修改新 owner 的
  watermark。
- `Lost` 不等待，立即递增 epoch。
- 新 `Assign` 会先围栏旧 epoch，再等待已经越过租约检查的 offset 提交排空，
  然后恢复日志并启动新 worker。

另外，`Revoke` 的成功路径会再次递增 epoch，防止 sink 违约重复调用 `done`
时产生迟到提交。

## 验证

测试覆盖：

- 每个分区全部记录只经过 sink 一次，offset 单调推进；
- `Revoke` 期间 reader 不再被调用，且在途 sink 回调完成后才返回；
- 撤销一个分区时另一个分区继续处理（协作式增量再均衡）；
- 撤销超时后旧 sink 回调迟到，不能推进新 owner 的 watermark；
- 文件日志崩溃尾帧截断与重启恢复，offset 提交失败后不重复写 sink；
- `TestEventPermutationsNoLossNoDuplication` 对 5 个 rebalance 事件的 120 种
  排列逐一执行，最后统一 drain，并断言两个分区所有 offset 均恰好提交一次。

```sh
go test ./... -race
```

## 边界

- `MemoryJournal` 仅用于测试；生产环境应使用 `FileJournal` 并保证单写者。
- 外部 sink 的幂等性是端到端“不重”的必要条件；协调层保证同一 offset 区间
  始终使用同一批次 ID，并在输出批次落盘后才提交 offset。
- 处理器必须确定性；相同输入区间若产生不同输出，sink 去重会保留第一次结果。
