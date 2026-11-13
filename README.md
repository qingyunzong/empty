# Pub/Sub 有序键租约接力

消息落地服务需要可导入的 Go Pub/Sub 有序键状态组件，协调 ack deadline、modifyAckDeadline、nack 与订阅重投。同一 ordering key 同时只有一个活跃前缀；租约丢失后旧处理者不能提交。无序键可独立推进，恢复后保持每键发布顺序。

## 用法

```go
sub := dataeng.NewSubscription(
    dataeng.WithAckDeadline(10*time.Second),
)
sub.Publish(dataeng.Message{ID: "m1", OrderingKey: "user-42"})

d := sub.Pull(ctx, 1)[0]   // 每个 ordering key 同时只租出队首一条
d.Extend(30 * time.Second) // modifyAckDeadline
d.Ack()                    // 租约丢失时返回 ErrLeaseLost
```

- `Delivery.Nack()` 等价于 modifyAckDeadline(0)，消息立即回到键首等待重投。
- 租约过期后由 `Pull` 回收并重投，旧句柄的 `Ack`/`Nack`/`Extend` 均被 fencing(`ErrLeaseLost`)。
- 空 `OrderingKey` 的消息各自独立调度，互不影响。
- `Snapshot` + `Restore`/`RestoreFrom` 用于崩溃恢复：未确认消息按每键发布顺序重建，`RestoreFrom` 会递增 fencing generation，使恢复前的所有租约失效。
