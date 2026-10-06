# commlib — 端到端恰好一次（exactly-once）消息传递示例

一个演示可靠消息传递语义的 Go 库：发送端使用**事务发件箱**，接收端按
**消息 ID 去重**并把去重标记与业务效果放在**同一个原子批次**提交；回执
（ack）允许丢失，发送端据此重试；同一 ID 载荷被篡改时拒绝投递。

## 设计

- `Sender`（`sender.go`）：`Enqueue` 把消息原子写入发件箱；`PumpOnce`
  逐条投递，只有收到 ack 且**退役删除持久化成功**后才移出发件箱。任何
  环节失败都安全重发。
- `Receiver`（`receiver.go`）：`Receive` 先查 `seen/<id>`；命中且载荷
  一致返回 `AckDuplicate`（幂等），载荷不一致返回 `AckConflict`（拒
  绝）。未命中时把去重记录、效果记录、已应用计数放在**一次
  `ApplyBatch`** 中提交——崩溃不会留下"有去重标记无效果"的中间态。
- `Store`（`store.go`）：`ApplyBatch` 是原子提交原语。`FaultyStore`
  注入两类持久层故障：提交前失败（不生效）与提交后失败（已生效但调用
  方看到错误，模拟提交后崩溃）。
- `FlakyTransport`（`transport.go`）：注入断网（partition）、请求丢
  失、回执丢失（消息已应用但发送端不知情，触发重传）。
- `Ledger`（`ledger.go`）：完整消息账本；`VerifyExactlyOnce` 校验最
  终效果与账本逐 ID 恰好一次、载荷一致，不多不少。

## 测试

```sh
go test ./...
go test -race ./...
```

`commlib_test.go` 覆盖：组合故障下的恰好一次对照、回执丢失重试、接收
端提交前/后崩溃的原子性、发送端发件箱写失败、同 ID 载荷改变被拒、断
网恢复、并发泵送（`-race`）。
