# OPC UA 订阅序号恢复

`example.org/dataeng/q0086` 是一个可导入的 Go OPC UA subscription 状态库。
它只维护发布序号与恢复状态，不绑定具体的 OPC UA 协议栈或存储实现。

## 行为

- 按 `NotificationMessage.SequenceNumber` 跟踪发布序号，重复消息不会重复交付。
- 发现缺口时先进入待重传队列，不会仅因 `availableSequenceNumbers` 中暂时没有该序号就判定丢失。
- `Republish` 返回 `BadMessageNotAvailable` 等明确的“不可用”状态后，才把序号标记为永久缺失。超时、会话失效等瞬时错误不会误判。
- keep-alive 的序号表示“下一个通知序号”，不会推进通知序号本身，但可以暴露缺口。
- `Transfer` 切换 session 后，旧 session 的 publish/republish 响应全部忽略，不修改状态。
- `Persist` 标记通知已落库；`Acknowledge` 只会推进到已持久化（或已确认永久缺失）的连续序号，不会确认尚未落库的通知。

## 使用

```go
s := dataeng.NewSubscription(dataeng.WithSessionID("session-1"), dataeng.WithSubscriptionID(42))

res := s.HandlePublish(dataeng.PublishResponse{
    SessionID:                "session-1",
    SubscriptionID:           42,
    SequenceNumber:           3,
    AvailableSequenceNumbers: []uint32{2, 3},
    NotificationData:         []dataeng.NotificationData{{Payload: payload}},
})

for _, seq := range res.PendingRepublish {
    // 调用 OPC UA Republish(seq)，然后：
    s.HandleRepublish(dataeng.RepublishResponse{
        SessionID:      "session-1",
        SubscriptionID: 42,
        SequenceNumber: seq,
        Status:         dataeng.BadMessageNotAvailable,
    })
}

if err := s.Persist(3); err == nil {
    ack := s.Acknowledge() // 返回可发送给服务器的安全确认水位
    _ = ack
}
```

## 验证

```sh
go test ./...
```
