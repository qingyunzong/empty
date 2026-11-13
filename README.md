# gRPC 服务端流恢复令牌

数据导出连接器可直接接入 Go gRPC 服务端流恢复组件，把应用记录 id、服务端
resume token、批次确认和连接世代绑定在一起。

## 接入方式

实现 `StreamOpener` 和 `Stream`，把 gRPC 的 `Recv` 映射为 `Batch`：

- `Batch.SnapshotID`、`Batch.Generation` 原样取自服务端响应；
- `Batch.ResumeToken` 是该批次全部记录对应的服务端恢复位置；
- 服务端判定 token 失效时，让 `Recv`/`Open` 返回 `ErrResumeTokenInvalid`
  （可用 `%w` 包装 gRPC status）；
- 服务端要求显式确认时，再实现 `AckStream`。

```go
type exportStream struct {
    stream Export_ExportClient
}

func (s *exportStream) Recv() (dataeng.Batch, error) {
    msg, err := s.stream.Recv()
    if err != nil {
        if status.Code(err) == codes.FailedPrecondition {
            return dataeng.Batch{}, dataeng.ErrResumeTokenInvalid
        }
        return dataeng.Batch{}, err
    }
    return dataeng.Batch{
        SnapshotID:  msg.SnapshotId,
        Generation:  msg.ConnectionGeneration,
        ResumeToken: msg.ResumeToken,
        Records:     toRecords(msg.Records),
    }, nil
}

func (s *exportStream) Close() error {
    return s.stream.CloseSend()
}
```

`StreamOpener.Open` 每次连接都会收到一个单调递增且已持久化的
`OpenRequest.Generation`。连接请求只使用 `OpenRequest.ResumeToken`，该值始终来自
最后一个已确认并持久化的批次。

## 一致性保证

- 批次先交给 `Sink.ApplyBatch`；返回 `nil` 后才持久化该批次的 resume token，
  然后才发送 `AckStream.Ack`。
- 网络中断、打开失败或确认失败都从 `Checkpoint.ResumeToken` 重连，绝不使用未确认
  批次的 token。
- 快照内按应用记录 id 维护最高版本。重连边界的等版本或旧版本记录不会再次交给
  Sink；更高版本正常交付。
- 响应快照 id 或连接世代与当前 checkpoint 不一致时，整条消息被丢弃，防止旧连接
  的迟到消息污染新连接。
- token 失效时调用 `SnapshotStarter.StartSnapshot` 创建新快照。新快照 id 必须与
  旧 id 不同；其记录以 `Replacement=true`、`Replaces=旧快照 id` 交付。
- 新快照完成后调用 `Sink.Reconcile`，给出 `Added`、`Removed`、`Changed` 和
  `Unchanged`。新结果不会被静默追加到旧结果之后。
- 替换快照再次失效时，通过 `SnapshotAbandoner.AbandonSnapshot` 丢弃该次部分结果，
  仍然与最后一个完整旧快照对账。
- 如果 `Reconcile` 失败，checkpoint 会保留 `PendingReconcile`，后续 `Run` 返回
  `ErrReconciliationPending`，不会把未对账的新快照标记为完成。

`Sink` 应保证 `ApplyBatch` 幂等，并在 `Reconcile` 前把替换快照与旧快照隔离暂存。
如果实现了可选的 `SnapshotLifecycle`，`BeginSnapshot` 会收到
`SnapshotInitial`、`SnapshotResume` 或 `SnapshotReplacement` 事件。

`CheckpointStore.Save` 必须是原子写入。库内置的 `MemoryStore` 仅用于测试或单进程
场景，生产环境应使用数据库/事务存储。

## 使用

```go
connector, err := dataeng.NewConnector(dataeng.Config{
    Opener:    opener,
    Snapshots: starter,
    Store:     store,
    Sink:      sink,
    Retry:     dataeng.RetryPolicy{InitialBackoff: 200 * time.Millisecond, MaxBackoff: 10 * time.Second},
})
if err != nil {
    return err
}
return connector.Run(ctx)
```

`RetryPolicy.MaxAttempts` 为零时持续重连，直到 `ctx` 被取消。`Stats` 可用于观测连接
次数、丢弃的旧世代批次、去重记录数和快照重启次数。

运行测试：

```sh
go test ./...
```
