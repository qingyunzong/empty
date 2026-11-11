采集服务通过SSE接收变更，需要可嵌入Go客户端的订阅组件。按UTF-8文本事件流解析跨块CR、LF及CRLF、data多行、id与retry；空id清除恢复标记，注释不发事件。一次只交付一个待确认事件，只有调用方确认后才把恢复ID写入注入存储，断线重连使用已确认ID并保留服务端建议等待时间。测试任意字节切块、确认持久化失败、取消与重连同时发生，保证正文流关闭且未确认事件不会被跳过。

## 包结构

- `decoder.go`：`Decoder`，按 WHATWG SSE 规范解析 UTF-8 文本事件流。
- `subscriber.go`：`Subscriber`，可嵌入客户端的订阅/重连/确认组件。
- `store.go`：`ResumeStore` 接口与进程内 `MemoryStore` 参考实现。
- `managed_stream.go`：幂等可关闭的正文流包装。

## 解析语义

- CR、LF、CRLF 都视为换行，且允许在任意字节切块边界被拆开。
- 多个 `data` 字段按 LF 拼接；`event` 缺省为 `message`。
- `id` 更新恢复标记，空 `id` 清除标记；含 NUL 的 `id` 被忽略。
- `retry` 仅接受纯十进制数字，作为服务端建议的重连等待保留。
- 以 `:` 开头的注释行不派发事件；流首 UTF-8 BOM 被剥离。
- 非法 UTF-8 字节替换为 `U+FFFD`；EOF 时残留的 data 会刷出为事件。

## 订阅与确认

- 同一时刻只有一个待确认事件：`Next` 取得事件后泵循环阻塞，
  直到 `Ack` 成功，后续事件不会被读取或跳过。
- `Ack` 调用注入的 `ResumeStore.Save`；持久化失败时返回错误，
  事件仍保持待确认，可重试 `Ack`。
- 空事件 ID 的 `Ack` 以空字符串调用 `Save`，由存储清除恢复标记。
- 断线重连携带最近一次已确认的 ID（`Last-Event-ID` 头），
  并沿用服务端最近一次 `retry` 建议，缺省为 `DefaultRetryMillis`。
- 任何时刻取消都会关闭当前正文流；`managedStream` 保证关闭幂等。

## 用法

```go
store := q150.NewMemoryStore()
sub, err := q150.NewSubscriber(q150.Config{
    URL:   "https://example.com/events",
    Store: store,
})
if err != nil {
    log.Fatal(err)
}
go func() { log.Print(sub.Run(ctx)) }()

for {
    event, err := sub.Next(ctx)
    if err != nil {
        return
    }
    if err := handle(event); err != nil {
        log.Print(err)
        continue // 不 Ack，重连后该事件会重新投递
    }
    if err := sub.Ack(ctx); err != nil {
        log.Print(err) // 持久化失败，事件未确认、不会丢失
    }
}
```

## 测试

- 解析：穷举单切点、逐字节、随机切块与 fuzz（任意字节、任意宽度）。
- 订阅：确认持久化失败、重连携带已确认 ID 与 retry、取消与重连
  等待并发、读取阻塞时取消、空 ID 清除标记、逐字节端到端投递。
- 全程 `go test -race` 验证无数据竞争，正文流关闭有显式断言。
