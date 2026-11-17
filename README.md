# 事务消息状态组件

这是一个可嵌入 Go 消息代理的事务状态机，持久化协调：

- `Prepare`：写入半消息，消息不可投递；
- `Commit` / `Rollback`：记录业务侧最终决定；
- `Due` / `MarkChecked`：超时回查与回查次数推进；
- 重复确认：返回已存储的最终结果，不重复追加日志。

事务引用是 `Ref{ID, Gen}`。`ID` 可复用，每次成功 prepare 分配严格递增的
`Gen`；未决代不允许换消息复用。旧代确认只能命中旧代，不能污染复用编号的
新代。最终决定后，重复请求返回同一 `Decision`，相反方向的请求返回原决定并
标记 `Conflict`。

## 用法

```go
store := formal.NewMemoryStore() // 或 formal.OpenFileStore(path)
c, err := formal.Open(store,
    formal.WithDefaultTimeout(30*time.Second),
    formal.WithRecheckInterval(10*time.Second),
)
if err != nil {
    return err
}

receipt, err := c.Prepare(formal.PrepareRequest{
    ID:      "order-42",
    Message: formal.Message{ID: "m-42", Topic: "orders", Body: payload},
})
if err != nil {
    return err
}

// 业务本地事务提交后确认。重复调用是幂等的。
decision, err := c.Commit(receipt.Ref)

// 可投递集合由提交记录重放而来，每个 Ref 至多出现一次。
for _, delivery := range c.Deliverable() {
    _ = delivery.Message
}
```

超时回查由调用方驱动：

```go
for _, check := range c.Due() {
    outcome := askBusiness(check.Message, check.Ref)
    switch outcome {
    case committed:
        c.Commit(check.Ref)
    case rolledBack:
        c.Rollback(check.Ref, "business rolled back")
    default:
        c.MarkChecked(check.Ref) // 仍未决，记录本次回查
    }
}
```

进程重启后重新 `Open` 同一个 `Store` 即可恢复事务状态、回查计数和可投递
集合。影响调度的选项（`WithRecheckInterval`、`WithMaxChecks`、
`WithDefaultTimeout`）应在重开时传入相同值。

## 持久化与不变量

日志帧为 `长度 + CRC32C + JSON`。`Store.Append` 返回成功前必须完成同步；
崩溃可能只留下任意字节前缀。`Open` 重放最长有效前缀并截断残缺尾部。

可投递集合以 `Ref`（事务号 + 代）去重，而不是以 `Message.ID` 去重；同一个
事务号的不同代代表不同的消息事务：

- prepare 已持久化但 commit 未持久化：消息不可见；
- commit 已持久化：消息恰好一次进入可投递集合；
- commit 记录被复制、或“已写入但返回错误”的模糊追加被重试：重放仍只产生
  一条投递；
- 旧代确认：只命中 `Ref{ID, 旧 Gen}`，不影响新代。

`crash_test.go` 对参考场景的每一条日志帧，枚举从帧首到帧尾的每个截断前缀，
逐个重放、补全决定、再次重放，并断言每个事务代在可投递集合中的数量始终为
0 或 1。另一个场景在崩溃恢复后复用同一事务号，验证旧代确认不会改变新代。

这里的“恰好一次”指恰好一次进入可投递集合；从该集合向消费者投递仍需要
消费端确认或幂等机制，不在本组件范围内。

## 测试

```sh
go test -race ./...
```
