# forward

`forward` 按块把请求体流式转发到多个目的地，核心语义：

- **按块读取**：`Source.ReadChunk` 一次一块，空块 `(0, nil)` 照常转发；
  `NewReaderSource` 可把 `io.Reader` 适配为块源。
- **限长即停**：累计字节超过 `Config.MaxBytes` 时，超限块立即丢弃、停止
  发布并关闭上游；随后等待全部在途写关闭才返回。限长错误为哨兵
  `ErrLimitExceeded`，上游读失败包装为 `*ReadError`，二者可区分。
- **前缀不算成功**：已发出的前缀不会让整体结果变成 `StateDelivered`。
- **共享租约**：同一原始块在所有目的地间共享（`Chunk.Retain/Release`），
  任一租约未释放都阻止池复用该缓冲区；`Pool.Outstanding` 可核验泄漏。
- **取消**：`context` 取消会关闭上游以解除阻塞读，并让阻塞中的
  `Sink.WriteChunk` 通过 ctx 退出。
- **唯一终态**：每次 `Forward` 只记录一个终态（`sync.Once`），主响应与
  取消竞争不会覆盖已交付状态。

```go
res := forward.New(forward.Config{MaxBytes: 1 << 20, ChunkSize: 32 << 10}).
    Forward(ctx, forward.NewReaderSource(body), sinkA, sinkB)
```

测试：`go test ./...`（竞态检测：`go test ./... -race`）。
