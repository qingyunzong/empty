IoT采集宿主需要Go MQTT QoS2接收组件，调用方提供已解码的PUBLISH、PUBREL及持久事务存储和业务落点。首次PUBLISH保存packet ID与载荷后才回PUBREC，重复同载荷重回PUBREC，异载荷拒绝；PUBREL把业务效果与完成标记在同一事务提交后回PUBCOMP，重传不能重复业务效果。完成后同ID的新PUBLISH允许开启下一代，未知PUBREL仅回PUBCOMP。持久会话断线恢复原状态，clean start清空协议状态；用各存储边界崩溃和packet ID复用测试，对业务落点提交次数逐项核对。

## 组件说明

`q190` 是与传输层解耦的 MQTT QoS 2 接收端状态机。调用方负责解码报文、发送 PUBREC/PUBCOMP，并提供两个边界：

- `Store`：持久化、可序列化事务的协议状态存储（`Begin`/`Load`/`Clear`，事务接口 `Tx`）。
- `Sink`：业务落点，在 PUBREL 事务内通过 `Apply` 把业务效果加入同一个事务，不得自行提交或回滚。

### 状态机语义

- 首次 PUBLISH：事务内保存 packet ID、generation（从 1 开始）与载荷，提交成功后返回 `PubrecAction{Stored:true}`，调用方才发 PUBREC。
- 重传 PUBLISH 且处于 `published` 阶段：载荷相同直接重发 PUBREC（`Stored:false`）；载荷不同返回 `RejectAction{Err:ErrPayloadMismatch}`，调用方应按协议错误断开。
- PUBREL：处于 `published` 时在同一事务内依次执行业务落点与完成标记，事务提交后才返回 `PubcompAction{Applied:true}`；之后重传 PUBREL 只回 PUBCOMP（`Applied:false`），落点不会重复执行。
- 完成后同 packet ID 的新 PUBLISH：开启下一代（generation 加 1），旧载荷被替换。
- 未知 PUBREL：不落业务、不写状态，仅返回 `PubcompAction{Unknown:true}`。
- 持久会话：不调用清理，重连用同一 `Store` 构造 `Receiver` 即可通过持久状态恢复。
- Clean start：调用 `Receiver.CleanStart` 清空全部协议状态，之后同 ID 从 generation 1 重新开始。

### 参考实现与故障注入

`MemoryStore` 是并发安全的内存参考实现，事务持有全库锁以保证可序列化，并对载荷做防御性拷贝。`MemoryHooks` 可在 Begin、PutPublish、PutComplete、Commit、Clear、Load 六个边界注入失败；Commit 失败时丢弃全部暂存改动，等价于崩溃未持久化。`Completions()` 保留每代提交历史，便于在 packet ID 复用后核对业务落点提交次数。

### 最小用法

```go
store := q190.NewMemoryStore()
sink := q190.SinkFunc(func(ctx context.Context, tx q190.Tx, rec q190.Record) error {
    native := tx.Underlying() // 真实存储的原生事务，在此事务内写业务数据
    _ = native
    return nil
})
recv := q190.NewReceiver(store, sink)

action, err := recv.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: payload})
// action 为 PubrecAction 后发送 PUBREC
pubcomp, err := recv.HandlePubrel(ctx, q190.Pubrel{PacketID: id})
// pubcomp 成功返回后发送 PUBCOMP
```

### 测试

`go test ./... -race` 覆盖正常交付、同载荷/异载荷重传、PUBREL 幂等、packet ID 多代复用、未知 PUBREL、clean start、跨接收器持久恢复、并发同 ID，以及六个存储边界崩溃后的重试与业务落点提交次数核对。
